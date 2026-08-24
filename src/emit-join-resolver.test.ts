import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { emitJoinResolver } from "./emit-join-resolver.js";
import { resolveJoinDependencies } from "./joins.js";
import {
	isSearchProjectionModel,
	type ResolvedProjection,
	resolveProjectionModel,
} from "./projection.js";
import { OpenSearchEmitterTestLibrary } from "./testing/index.js";

async function createRunner() {
	const host = await createTestHost({
		libraries: [OpenSearchEmitterTestLibrary],
	});

	return createTestWrapper(host, {
		autoImports: ["@kattebak/typespec-opensearch-emitter"],
		autoUsings: ["Kattebak.OpenSearch"],
	});
}

async function resolveAll(code: string) {
	const runner = await createRunner();
	await runner.diagnose(code);

	const program = runner.program;
	const projections: ResolvedProjection[] = [];
	for (const model of program.getGlobalNamespaceType().models.values()) {
		if (!isSearchProjectionModel(program, model)) continue;
		const projection = resolveProjectionModel(program, model);
		if (!projection) continue;
		projections.push({
			...projection,
			joins: resolveJoinDependencies(program, model),
		});
	}

	return { program, projections };
}

const PET_CARE = `
	model Pet {
		@searchable @keyword petId: string;
		@searchable @keyword passportId: string;
	}

	@resolvableBy(PetPassport.passportId)
	model PetPassport {
		passportId: string;
		@searchable @keyword microchipId: string;
	}

	@resolvableBy(OwnershipRecord.petId, "byPetId")
	model OwnershipRecord {
		ownershipRecordId: string;
		petId: string;
		@searchable @keyword ownerName: string;
	}

	model PetPassportSearchDoc is SearchProjection<PetPassport> {}
	model OwnershipRecordSearchDoc is SearchProjection<OwnershipRecord> {}

	@searchProjection
	@indexName("pet_care_v1")
	@dependsOn(PetPassport, "lookup", Pet.passportId)
	@dependsOn(OwnershipRecord, "inbound", OwnershipRecord.petId)
	model PetCareSearchDoc is SearchProjection<Pet> {
		passport?: PetPassportSearchDoc;
		@nested ownershipHistory: OwnershipRecordSearchDoc[];
	}
`;

function emitFor(
	program: Parameters<typeof emitJoinResolver>[0],
	projections: ResolvedProjection[],
	name: string,
) {
	const projection = projections.find(
		(x) => x.projectionModel.name === name,
	) as ResolvedProjection;
	assert.ok(projection);
	return emitJoinResolver(program, projection, projections);
}

describe("emitJoinResolver", () => {
	it("emits one method per declaration, typed from the joined document", async () => {
		const { program, projections } = await resolveAll(PET_CARE);

		const file = emitFor(program, projections, "PetCareSearchDoc");
		assert.ok(file);
		assert.equal(file.fileName, "pet-care-search-doc-join-resolver.ts");

		assert.equal(
			file.content,
			`import type { OwnershipRecordSearchDoc } from "./ownership-record-search-doc.js";
import type { PetPassportSearchDoc } from "./pet-passport-search-doc.js";

export interface PetCareSearchDocJoinResolver {
	lookupPetPassport(passportId: string): Promise<PetPassportSearchDoc | undefined>;
	discoverOwnershipRecord(petId: string): Promise<OwnershipRecordSearchDoc[]>;
}
`,
		);
	});

	it("emits nothing for a projection with no declared joins", async () => {
		const { program, projections } = await resolveAll(`
			model Pet {
				@searchable @keyword petId: string;
			}

			@searchProjection
			@indexName("pets_v1")
			model PetSearchDoc is SearchProjection<Pet> {}
		`);

		assert.equal(emitFor(program, projections, "PetSearchDoc"), undefined);
	});

	it("declares the entity inline when the spec projects no document for it", async () => {
		const { program, projections } = await resolveAll(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passportId: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				microchipId: string;
				boosterDue?: utcDateTime;
			}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {}
		`);

		const file = emitFor(program, projections, "PetCareSearchDoc");
		assert.ok(file);
		assert.ok(!file.content.includes("import type"));
		assert.ok(
			file.content.includes(`export interface PetPassport {
	passportId: string;
	microchipId: string;
	boosterDue?: string;
}`),
		);
		assert.ok(
			file.content.includes(
				"lookupPetPassport(passportId: string): Promise<PetPassport | undefined>;",
			),
		);
	});

	it("disambiguates two joins that would otherwise share a method name", async () => {
		const { program, projections } = await resolveAll(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passportId: string;
				@searchable @keyword litterPassportId: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				@searchable @keyword microchipId: string;
			}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			@dependsOn(PetPassport, "lookup", Pet.litterPassportId)
			model PetCareSearchDoc is SearchProjection<Pet> {}
		`);

		const file = emitFor(program, projections, "PetCareSearchDoc");
		assert.ok(file);
		assert.ok(file.content.includes("lookupPetPassport(passportId: string)"));
		assert.ok(
			file.content.includes(
				"lookupPetPassportByLitterPassportId(litterPassportId: string)",
			),
		);
	});
});
