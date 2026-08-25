import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Program } from "@typespec/compiler";
import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { HttpTestLibrary } from "@typespec/http/testing";
import { emitJoinResolver } from "./emit-join-resolver.js";
import {
	type ResolvedProjection,
	resolveProjectionModel,
} from "./projection.js";
import { isSearchProjectionModel } from "./projection-source.js";
import { OpenSearchEmitterTestLibrary } from "./testing/index.js";

async function createRunner() {
	const host = await createTestHost({
		libraries: [HttpTestLibrary, OpenSearchEmitterTestLibrary],
	});

	return createTestWrapper(host, {
		autoImports: ["@typespec/http", "@kattebak/typespec-opensearch-emitter"],
		autoUsings: ["TypeSpec.Http", "Kattebak.OpenSearch"],
	});
}

async function resolveAll(code: string) {
	const runner = await createRunner();
	const diagnostics = await runner.diagnose(code);
	assert.deepEqual(
		diagnostics.filter((x) => x.severity === "error"),
		[],
	);

	const program = runner.program;
	const projections: ResolvedProjection[] = [];
	for (const model of program.getGlobalNamespaceType().models.values()) {
		if (!isSearchProjectionModel(program, model)) continue;
		const projection = resolveProjectionModel(program, model);
		if (!projection) continue;
		projections.push(projection);
	}

	return { program, projections };
}

function emitFor(
	program: Program,
	projections: ResolvedProjection[],
	name: string,
) {
	const projection = projections.find((x) => x.projectionModel.name === name);
	assert.ok(projection);
	return emitJoinResolver(program, projection);
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

	@route("/pet-passports")
	namespace PetPassports {
		@restResolver @get op getPetPassport(@path passportId: string): PetPassport;
	}

	@route("/ownership-records")
	namespace OwnershipRecords {
		@restResolver @get op listOwnershipRecords(@query petId: string): OwnershipRecord[];
	}
`;

describe("emitJoinResolver", () => {
	it("names each method for the field it fills and types it from that field", async () => {
		const { program, projections } = await resolveAll(PET_CARE);

		const file = emitFor(program, projections, "PetCareSearchDoc");
		assert.ok(file);
		assert.equal(file.fileName, "pet-care-search-doc-join-resolver.ts");

		assert.equal(
			file.content,
			`import type { OwnershipRecordSearchDoc } from "./ownership-record-search-doc.js";
import type { PetPassportSearchDoc } from "./pet-passport-search-doc.js";

export interface PetCareSearchDocJoinResolver {
	lookupPassport(passportId: string): Promise<PetPassportSearchDoc | undefined>;
	discoverOwnershipHistory(petId: string): Promise<OwnershipRecordSearchDoc[]>;
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

	it("declares the entity inline when the field names the model itself", async () => {
		const { program, projections } = await resolveAll(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passportId: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				@searchable @keyword microchipId: string;
				boosterDue?: utcDateTime;
			}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				passport?: PetPassport;
			}

			@route("/pet-passports")
			namespace PetPassports {
				@restResolver @get op getPetPassport(@path passportId: string): PetPassport;
			}
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
				"lookupPassport(passportId: string): Promise<PetPassport | undefined>;",
			),
		);
	});

	it("keeps two joins over the same entity apart by the field each fills", async () => {
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

			@resolvableBy(LitterPassport.passportId)
			model LitterPassport {
				passportId: string;
				@searchable @keyword breederId: string;
			}

			model PetPassportSearchDoc is SearchProjection<PetPassport> {}
			model LitterPassportSearchDoc is SearchProjection<LitterPassport> {}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			@dependsOn(LitterPassport, "lookup", Pet.litterPassportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				passport?: PetPassportSearchDoc;
				litterPassport?: LitterPassportSearchDoc;
			}

			@route("/passports")
			namespace Passports {
				@restResolver @get op getPetPassport(@path passportId: string): PetPassport;
			}

			@route("/litter-passports")
			namespace LitterPassports {
				@restResolver @get op getLitterPassport(@path passportId: string): LitterPassport;
			}
		`);

		const file = emitFor(program, projections, "PetCareSearchDoc");
		assert.ok(file);
		assert.ok(
			file.content.includes(
				"lookupPassport(passportId: string): Promise<PetPassportSearchDoc | undefined>;",
			),
		);
		assert.ok(
			file.content.includes(
				"lookupLitterPassport(litterPassportId: string): Promise<LitterPassportSearchDoc | undefined>;",
			),
		);
	});
});
