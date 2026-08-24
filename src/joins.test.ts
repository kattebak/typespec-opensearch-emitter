import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { getJoinDependencies, getResolvableBy } from "./decorators.js";
import {
	resolveJoinDependencies,
	toJoinDependencyManifestEntry,
	toResolvableByManifestEntry,
} from "./joins.js";
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

function hasDiagnosticCode(
	diagnosticCodes: readonly string[],
	code: string,
): boolean {
	return diagnosticCodes.some((x) => x.endsWith(`/${code}`) || x === code);
}

function diagnosticsWithCode(
	diagnostics: readonly { code: string; target: unknown }[],
	code: string,
) {
	return diagnostics.filter((x) => hasDiagnosticCode([x.code], code));
}

// The pet care view from issue #194: Waffles the beagle has a passport,
// Nugget the stray does not. Both joins are left joins.
const PET_CARE = `
	model Pet {
		@searchable @keyword petId: string;
		@searchable @keyword name: string;
		@searchable @keyword passportId: string;
	}

	@resolvableBy(PetPassport.passportId)
	model PetPassport {
		passportId: string;
		@searchable @keyword microchipId: string;
		@searchable @keyword issuedCountry: string;
		@searchable @keyword vaccinations: string[];
	}

	@resolvableBy(OwnershipRecord.petId, "byPetId")
	model OwnershipRecord {
		ownershipRecordId: string;
		petId: string;
		@searchable @keyword ownerName: string;
		@searchable @filterable("range") transferredAt: utcDateTime;
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

describe("@resolvableBy / @dependsOn", () => {
	it("compiles the pet care view and lands both declarations in the state map", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(PET_CARE);

		assert.deepEqual(
			diagnostics.map((x) => x.code),
			[],
		);

		const globals = runner.program.getGlobalNamespaceType();
		const passport = globals.models.get("PetPassport");
		const ownership = globals.models.get("OwnershipRecord");
		const petCare = globals.models.get("PetCareSearchDoc");
		assert.ok(passport && ownership && petCare);

		const passportResolvable = getResolvableBy(runner.program, passport);
		assert.equal(
			passportResolvable?.key,
			passport.properties.get("passportId"),
		);
		assert.equal(passportResolvable?.index, undefined);

		const ownershipResolvable = getResolvableBy(runner.program, ownership);
		assert.equal(ownershipResolvable?.key, ownership.properties.get("petId"));
		assert.equal(ownershipResolvable?.index, "byPetId");

		const dependencies = getJoinDependencies(runner.program, petCare);
		assert.equal(dependencies.length, 2);
		assert.deepEqual(
			dependencies.map((x) => [x.entity.name, x.direction, x.joinKey.name]),
			[
				["PetPassport", "lookup", "passportId"],
				["OwnershipRecord", "inbound", "petId"],
			],
		);
	});

	it("does not warn that a join-provided field is absent from the source model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(PET_CARE);

		assert.equal(
			hasDiagnosticCode(
				diagnostics.map((x) => x.code),
				"projection-field-not-on-source",
			),
			false,
		);
	});

	it("resolves dependencies into manifest entries, carrying the declared index", async () => {
		const runner = await createRunner();
		await runner.diagnose(PET_CARE);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		const dependencies = resolveJoinDependencies(runner.program, petCare).map(
			toJoinDependencyManifestEntry,
		);

		assert.deepEqual(dependencies, [
			{ entity: "PetPassport", direction: "lookup", joinKey: "passportId" },
			{
				entity: "OwnershipRecord",
				direction: "inbound",
				joinKey: "petId",
				index: "byPetId",
			},
		]);
	});

	it("resolves a resolvableBy manifest entry per entity", async () => {
		const runner = await createRunner();
		await runner.diagnose(PET_CARE);

		const globals = runner.program.getGlobalNamespaceType();
		const passport = globals.models.get("PetPassport");
		const ownership = globals.models.get("OwnershipRecord");
		const pet = globals.models.get("Pet");
		assert.ok(passport && ownership && pet);

		assert.deepEqual(toResolvableByManifestEntry(runner.program, passport), {
			entity: "PetPassport",
			key: "passportId",
		});
		assert.deepEqual(toResolvableByManifestEntry(runner.program, ownership), {
			entity: "OwnershipRecord",
			key: "petId",
			index: "byPetId",
		});
		assert.equal(toResolvableByManifestEntry(runner.program, pet), undefined);
	});

	it("reports unknown-join-key when @resolvableBy names a key on another model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			model Pet {
				petId: string;
			}

			@resolvableBy(Pet.petId)
			model PetPassport {
				passportId: string;
				@searchable @keyword microchipId: string;
			}
		`);

		const reported = diagnosticsWithCode(diagnostics, "unknown-join-key");
		assert.equal(reported.length, 1);

		const pet = runner.program.getGlobalNamespaceType().models.get("Pet");
		assert.equal(reported[0].target, pet?.properties.get("petId"));
	});

	it("reports unknown-join-key when a lookup join key is not on the source model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			model Pet {
				@searchable @keyword petId: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				@searchable @keyword microchipId: string;
			}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", PetPassport.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {}
		`);

		const reported = diagnosticsWithCode(diagnostics, "unknown-join-key");
		assert.equal(reported.length, 1);

		const passport = runner.program
			.getGlobalNamespaceType()
			.models.get("PetPassport");
		assert.equal(reported[0].target, passport?.properties.get("passportId"));
	});

	it("reports join-index-required for an inbound join whose entity declares no index", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			model Pet {
				@searchable @keyword petId: string;
			}

			@resolvableBy(OwnershipRecord.petId)
			model OwnershipRecord {
				petId: string;
				@searchable @keyword ownerName: string;
			}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(OwnershipRecord, "inbound", OwnershipRecord.petId)
			model PetCareSearchDoc is SearchProjection<Pet> {}
		`);

		const reported = diagnosticsWithCode(diagnostics, "join-index-required");
		assert.equal(reported.length, 1);

		const ownership = runner.program
			.getGlobalNamespaceType()
			.models.get("OwnershipRecord");
		assert.equal(reported[0].target, ownership);
	});

	it("reports undeclared-join-resolution when the joined entity carries no @resolvableBy", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passportId: string;
			}

			model PetPassport {
				passportId: string;
				@searchable @keyword microchipId: string;
			}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {}
		`);

		const reported = diagnosticsWithCode(
			diagnostics,
			"undeclared-join-resolution",
		);
		assert.equal(reported.length, 1);

		const passport = runner.program
			.getGlobalNamespaceType()
			.models.get("PetPassport");
		assert.equal(reported[0].target, passport);
	});

	it("reports invalid-join-direction for a direction that is neither lookup nor inbound", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passportId: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				@searchable @keyword microchipId: string;
			}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "outbound", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {}
		`);

		const reported = diagnosticsWithCode(diagnostics, "invalid-join-direction");
		assert.equal(reported.length, 1);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.equal(reported[0].target, petCare);
	});

	it("drops an unresolvable declaration rather than emitting a half-formed dependency", async () => {
		const runner = await createRunner();
		await runner.diagnose(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passportId: string;
			}

			model PetPassport {
				passportId: string;
				@searchable @keyword microchipId: string;
			}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {}
		`);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		assert.deepEqual(resolveJoinDependencies(runner.program, petCare), []);
	});
});
