import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Diagnostic } from "@typespec/compiler";
import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { HttpTestLibrary } from "@typespec/http/testing";
import { collectAggregations } from "./aggregations.js";
import { getJoinDependencies, getResolvableBy } from "./decorators.js";
import { buildSearchFilterShape } from "./filters.js";
import {
	collectJoinDependencies,
	resolveJoinDependencies,
	toJoinDependencyManifestEntry,
	toResolvableByManifestEntry,
} from "./joins.js";
import { resolveProjectionModel } from "./projection.js";
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

function shortCode(diagnostic: Diagnostic): string {
	return diagnostic.code.replace(/^.*\//, "");
}

function withCode(
	diagnostics: readonly Diagnostic[],
	code: string,
): Diagnostic[] {
	return diagnostics.filter((x) => shortCode(x) === code);
}

// The pet care view from issue #194: Waffles the beagle has a passport,
// Nugget the stray does not. Both joins are left joins.
const ENTITIES = `
	model Pet {
		@searchable @keyword petId: string;
		@searchable @keyword name: string;
		@searchable @keyword passportId: string;
	}

	@resolvableBy(PetPassport.passportId)
	model PetPassport {
		passportId: string;
		@searchable @keyword microchipId: string;
		@searchable @keyword @filterable("term") @aggregatable("terms") issuedCountry: string;
		@searchable @keyword vaccinations: string[];
	}

	@resolvableBy(OwnershipRecord.petId, "byPetId")
	model OwnershipRecord {
		ownershipRecordId: string;
		petId: string;
		@searchable @keyword @filterable("term") ownerName: string;
		@searchable @filterable("range") transferredAt: utcDateTime;
	}

	model PetPassportSearchDoc is SearchProjection<PetPassport> {}
	model OwnershipRecordSearchDoc is SearchProjection<OwnershipRecord> {}
`;

const READS = `
	@route("/pet-passports")
	namespace PetPassports {
		@restResolver @get op getPetPassport(@path passportId: string): PetPassport;
	}

	@route("/ownership-records")
	namespace OwnershipRecords {
		@restResolver @get op listOwnershipRecords(@query petId: string): OwnershipRecord[];
	}
`;

const PET_CARE = `
	${ENTITIES}

	@searchProjection
	@indexName("pet_care_v1")
	@dependsOn(PetPassport, "lookup", Pet.passportId)
	@dependsOn(OwnershipRecord, "inbound", OwnershipRecord.petId)
	model PetCareSearchDoc is SearchProjection<Pet> {
		passport?: PetPassportSearchDoc;
		@nested ownershipHistory: OwnershipRecordSearchDoc[];
	}

	${READS}
`;

describe("@resolvableBy / @dependsOn", () => {
	it("compiles the pet care view and lands both declarations in the state map", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(PET_CARE);

		assert.deepEqual(diagnostics.map(shortCode), []);

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

		assert.deepEqual(
			getJoinDependencies(runner.program, petCare).map((x) => [
				x.entity.name,
				x.direction,
				x.joinKey.name,
			]),
			[
				["PetPassport", "lookup", "passportId"],
				["OwnershipRecord", "inbound", "petId"],
			],
		);
	});

	it("binds each declaration to the field it fills, carrying the index on the discovery join only", async () => {
		const runner = await createRunner();
		await runner.diagnose(PET_CARE);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		assert.deepEqual(
			resolveJoinDependencies(runner.program, petCare).map((x) =>
				toJoinDependencyManifestEntry(runner.program, x),
			),
			[
				{
					entity: "PetPassport",
					direction: "lookup",
					joinKey: "passportId",
					field: "passport",
				},
				{
					entity: "OwnershipRecord",
					direction: "inbound",
					joinKey: "petId",
					field: "ownershipHistory",
					index: "byPetId",
				},
			],
		);
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

	it("accepts a join key inherited from a base model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			model Chipped {
				passportId: string;
			}

			model Pet {
				@searchable @keyword petId: string;
			}

			model Registered {
				passportId: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport extends Registered {
				@searchable @keyword microchipId: string;
			}

			model PetPassportSearchDoc is SearchProjection<PetPassport> {}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", PetCareSource.passportId)
			model PetCareSearchDoc is SearchProjection<PetCareSource> {
				passport?: PetPassportSearchDoc;
			}

			model PetCareSource extends Chipped {
				@searchable @keyword petId: string;
			}

			@route("/pet-passports")
			namespace PetPassports {
				@restResolver @get op getPetPassport(@path passportId: string): PetPassport;
			}
		`);

		assert.deepEqual(withCode(diagnostics, "unknown-join-key"), []);
		assert.deepEqual(
			diagnostics.filter((x) => x.severity === "error"),
			[],
		);
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

		const reported = withCode(diagnostics, "unknown-join-key");
		assert.equal(reported.length, 1);

		const pet = runner.program.getGlobalNamespaceType().models.get("Pet");
		assert.equal(reported[0].target, pet?.properties.get("petId"));
	});

	it("reports unknown-join-key when a lookup join key is not on the source model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			${ENTITIES}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", PetPassport.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				passport?: PetPassportSearchDoc;
			}

			${READS}
		`);

		const reported = withCode(diagnostics, "unknown-join-key");
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

			model OwnershipRecordSearchDoc is SearchProjection<OwnershipRecord> {}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(OwnershipRecord, "inbound", OwnershipRecord.petId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				@nested ownershipHistory: OwnershipRecordSearchDoc[];
			}
		`);

		const reported = withCode(diagnostics, "join-index-required");
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

			model PetPassportSearchDoc is SearchProjection<PetPassport> {}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				passport?: PetPassportSearchDoc;
			}
		`);

		const reported = withCode(diagnostics, "undeclared-join-resolution");
		assert.equal(reported.length, 1);

		const passport = runner.program
			.getGlobalNamespaceType()
			.models.get("PetPassport");
		assert.equal(reported[0].target, passport);
	});

	it("reports invalid-join-direction for a direction that is neither lookup nor inbound", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			${ENTITIES}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "outbound", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				passport?: PetPassportSearchDoc;
			}

			${READS}
		`);

		const reported = withCode(diagnostics, "invalid-join-direction");
		assert.equal(reported.length, 1);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.equal(reported[0].target, petCare);
	});

	it("reports join-requires-projection when @dependsOn sits on a plain model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			${ENTITIES}

			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareView {
				passport?: PetPassportSearchDoc;
			}

			${READS}
		`);

		const reported = withCode(diagnostics, "join-requires-projection");
		assert.equal(reported.length, 1);

		const view = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareView");
		assert.equal(reported[0].target, view);
	});

	it("reports join-field-missing when nothing on the projection receives the join", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			${ENTITIES}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {}

			${READS}
		`);

		const reported = withCode(diagnostics, "join-field-missing");
		assert.equal(reported.length, 1);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.equal(reported[0].target, petCare);
	});

	it("reports join-field-ambiguous when two fields could receive the same join", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			${ENTITIES}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				passport?: PetPassportSearchDoc;
				passprot?: PetPassportSearchDoc;
			}

			${READS}
		`);

		const reported = withCode(diagnostics, "join-field-ambiguous");
		assert.equal(reported.length, 1);
		assert.match(reported[0].message, /passport, passprot/);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.equal(reported[0].target, petCare);
	});

	it("reports join-field-arity when a discovery join fills a single-valued field", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			${ENTITIES}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(OwnershipRecord, "inbound", OwnershipRecord.petId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				ownershipHistory?: OwnershipRecordSearchDoc;
			}

			${READS}
		`);

		const reported = withCode(diagnostics, "join-field-arity");
		assert.equal(reported.length, 1);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.equal(
			reported[0].target,
			petCare?.properties.get("ownershipHistory"),
		);
	});

	it("reports join-field-arity when a lookup fills an array field", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			${ENTITIES}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				@nested passport: PetPassportSearchDoc[];
			}

			${READS}
		`);

		assert.equal(withCode(diagnostics, "join-field-arity").length, 1);
	});

	it("reports join-read-operation-missing when no read is keyed by the declared key", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				@searchable @keyword microchipId: string;
			}

			@route("/pet-passports")
			namespace PetPassports {
				@restResolver @get op listPetPassports(): PetPassport[];
			}
		`);

		const reported = withCode(diagnostics, "join-read-operation-missing");
		assert.equal(reported.length, 1);

		const passport = runner.program
			.getGlobalNamespaceType()
			.models.get("PetPassport");
		assert.equal(reported[0].target, passport);
	});

	it("reports join-field-not-composed when nothing states what the joined entity contributes", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passportId: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				microchipId: string;
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

		const reported = withCode(diagnostics, "join-field-not-composed");
		assert.equal(reported.length, 1);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.equal(reported[0].target, petCare?.properties.get("passport"));
	});

	it("composes a join field typed as the entity itself from its @searchable properties", async () => {
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
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				passport?: PetPassport;
			}

			@route("/pet-passports")
			namespace PetPassports {
				@restResolver @get op getPetPassport(@path passportId: string): PetPassport;
			}
		`);

		assert.deepEqual(diagnostics.map(shortCode), []);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		const resolved = resolveProjectionModel(runner.program, petCare);
		assert.deepEqual(
			resolved?.fields.map((x) => x.name),
			["petId", "passportId", "passport"],
		);
	});

	it("drops an unresolvable declaration rather than emitting a half-formed dependency", async () => {
		const runner = await createRunner();
		await runner.diagnose(`
			${ENTITIES}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {}

			${READS}
		`);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		assert.deepEqual(resolveJoinDependencies(runner.program, petCare), []);
	});
});

describe("projection resolution of join fields", () => {
	it("composes a lookup as a single-valued field and an inbound as an array", async () => {
		const runner = await createRunner();
		await runner.diagnose(PET_CARE);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		const resolved = resolveProjectionModel(runner.program, petCare);
		assert.ok(resolved);

		const passport = resolved.fields.find((x) => x.name === "passport");
		assert.ok(passport);
		assert.equal(passport.optional, true);
		assert.equal(passport.nested, false);
		assert.equal(passport.searchable, true);
		assert.equal(
			passport.subProjection?.projectionModel.name,
			"PetPassportSearchDoc",
		);

		const history = resolved.fields.find((x) => x.name === "ownershipHistory");
		assert.ok(history);
		assert.equal(history.optional, false);
		assert.equal(history.nested, true);
		assert.equal(history.searchable, true);
		assert.equal(
			history.subProjection?.projectionModel.name,
			"OwnershipRecordSearchDoc",
		);
	});

	it("carries a joined field's own filterables and aggregations into the parent", async () => {
		const runner = await createRunner();
		await runner.diagnose(PET_CARE);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		const resolved = resolveProjectionModel(runner.program, petCare);
		assert.ok(resolved);

		assert.deepEqual(
			collectAggregations(resolved).map((x) => [
				x.aggName,
				x.openSearchField,
				x.nestedPath,
			]),
			[["byPassportIssuedCountry", "passport.issuedCountry", undefined]],
		);

		assert.deepEqual(
			buildSearchFilterShape(resolved)?.nodes.map((x) => [x.inputName, x.kind]),
			[
				["passport", "object"],
				["ownershipHistory", "nested"],
			],
		);
	});

	it("does not report a join field as absent from the source model", async () => {
		const runner = await createRunner();
		await runner.diagnose(PET_CARE);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		const before = runner.program.diagnostics.length;
		resolveProjectionModel(runner.program, petCare);

		assert.deepEqual(
			withCode(
				runner.program.diagnostics.slice(before),
				"projection-field-not-on-source",
			),
			[],
		);
	});

	it("reports join-cycle when a projection joins itself, instead of recursing forever", async () => {
		const runner = await createRunner();
		await runner.diagnose(`
			@resolvableBy(Pet.petId)
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword name: string;
				@searchable @keyword parentId: string;
			}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(Pet, "lookup", Pet.parentId)
			model PetSearchDoc is SearchProjection<Pet> {
				parent?: PetSearchDoc;
			}

			@route("/pets")
			namespace Pets {
				@restResolver @get op getPet(@path petId: string): Pet;
			}
		`);

		const pet = runner.program
			.getGlobalNamespaceType()
			.models.get("PetSearchDoc");
		assert.ok(pet);

		const before = runner.program.diagnostics.length;
		const resolved = resolveProjectionModel(runner.program, pet);
		assert.ok(resolved);

		const reported = withCode(
			runner.program.diagnostics.slice(before),
			"join-cycle",
		);
		assert.equal(reported.length, 1);
		assert.equal(reported[0].target, pet.properties.get("parent"));

		// The cycle takes the whole declaration with it: an entity the document
		// does not carry must not name a re-index trigger either.
		assert.deepEqual(
			resolved.fields.map((x) => x.name),
			["petId", "name", "parentId"],
		);
		assert.deepEqual(resolved.joins, []);
	});

	it("reports join-cycle when two projections compose each other", async () => {
		const runner = await createRunner();
		await runner.diagnose(`
			@resolvableBy(Owner.ownerId)
			model Owner {
				@searchable @keyword ownerId: string;
				@searchable @keyword petId: string;
			}

			@resolvableBy(Pet.petId)
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword ownerId: string;
			}

			@dependsOn(Owner, "lookup", Pet.ownerId)
			model PetSearchDoc is SearchProjection<Pet> {
				owner?: OwnerSearchDoc;
			}

			@searchProjection
			@indexName("owners_v1")
			@dependsOn(Pet, "lookup", Owner.petId)
			model OwnerSearchDoc is SearchProjection<Owner> {
				pet?: PetSearchDoc;
			}

			@route("/pets")
			namespace Pets {
				@restResolver @get op getPet(@path petId: string): Pet;
			}

			@route("/owners")
			namespace Owners {
				@restResolver @get op getOwner(@path ownerId: string): Owner;
			}
		`);

		const owner = runner.program
			.getGlobalNamespaceType()
			.models.get("OwnerSearchDoc");
		assert.ok(owner);

		const before = runner.program.diagnostics.length;
		const resolved = resolveProjectionModel(runner.program, owner);
		assert.ok(resolved);

		const reported = withCode(
			runner.program.diagnostics.slice(before),
			"join-cycle",
		);
		assert.equal(reported.length, 1);

		const pet = resolved.fields.find((x) => x.name === "pet");
		assert.ok(pet);
		assert.deepEqual(
			pet.subProjection?.fields.map((x) => x.name),
			["petId", "ownerId"],
		);
		assert.deepEqual(pet.subProjection?.joins, []);
	});

	it("reports join-field-collision when a join field is already resolved from the source", async () => {
		const runner = await createRunner();
		await runner.diagnose(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passport: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				@searchable @keyword microchipId: string;
			}

			model PetPassportSearchDoc is SearchProjection<PetPassport> {}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.petId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				passport?: PetPassportSearchDoc;
			}

			@route("/pet-passports")
			namespace PetPassports {
				@restResolver @get op getPetPassport(@path passportId: string): PetPassport;
			}
		`);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		const before = runner.program.diagnostics.length;
		const resolved = resolveProjectionModel(runner.program, petCare);
		assert.ok(resolved);

		const reported = withCode(
			runner.program.diagnostics.slice(before),
			"join-field-collision",
		);
		assert.equal(reported.length, 1);
		assert.equal(reported[0].target, petCare.properties.get("passport"));

		assert.deepEqual(
			resolved.fields.map((x) => x.name),
			["petId", "passport"],
		);
		assert.deepEqual(resolved.joins, []);
	});

	it("composes an entity declaring only @filterable and @aggregatable", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passportId: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				@keyword @filterable("term") @aggregatable("terms") issuedCountry: string;
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

		assert.deepEqual(diagnostics.map(shortCode), []);
	});

	it("reports join-field-not-composed for a search document that resolves no field", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passportId: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				microchipId: string;
			}

			model PetPassportSearchDoc is SearchProjection<PetPassport> {}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				passport?: PetPassportSearchDoc;
			}

			@route("/pet-passports")
			namespace PetPassports {
				@restResolver @get op getPetPassport(@path passportId: string): PetPassport;
			}
		`);

		const reported = withCode(diagnostics, "join-field-not-composed");
		assert.equal(reported.length, 1);
	});

	it("still reports a field that no join accounts for", async () => {
		const runner = await createRunner();
		await runner.diagnose(`
			${ENTITIES}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				passport?: PetPassportSearchDoc;
				kennelName?: string;
			}

			${READS}
		`);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		const before = runner.program.diagnostics.length;
		resolveProjectionModel(runner.program, petCare);

		const reported = withCode(
			runner.program.diagnostics.slice(before),
			"projection-field-not-on-source",
		);
		assert.equal(reported.length, 1);
		assert.equal(reported[0].target, petCare.properties.get("kennelName"));
	});

	it("carries the filter and aggregation contract of an entity-typed join field", async () => {
		const runner = await createRunner();
		await runner.diagnose(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passportId: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				@searchable @keyword @filterable("term") @aggregatable("terms") issuedCountry: string;
				notInTheDocument: string;
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

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		const resolved = resolveProjectionModel(runner.program, petCare);
		assert.ok(resolved);

		const passport = resolved.fields.find((x) => x.name === "passport");
		assert.deepEqual(
			passport?.subProjection?.fields.map((x) => x.name),
			["issuedCountry"],
		);

		assert.deepEqual(
			collectAggregations(resolved).map((x) => [x.aggName, x.openSearchField]),
			[["byPassportIssuedCountry", "passport.issuedCountry"]],
		);

		assert.deepEqual(
			buildSearchFilterShape(resolved)?.nodes.map((x) => [x.inputName, x.kind]),
			[["passport", "object"]],
		);
	});
});

describe("join dependency manifest entries", () => {
	it("closes over a transitive join, keyed by its path in the composed document", async () => {
		const runner = await createRunner();
		await runner.diagnose(`
			model Pet {
				@searchable @keyword petId: string;
				@searchable @keyword passportId: string;
			}

			@resolvableBy(PetPassport.passportId)
			model PetPassport {
				passportId: string;
				@searchable @keyword vetId: string;
			}

			@resolvableBy(Vet.vetId)
			model Vet {
				vetId: string;
				@searchable @keyword clinic: string;
			}

			model VetSearchDoc is SearchProjection<Vet> {}

			@dependsOn(Vet, "lookup", PetPassport.vetId)
			model PetPassportSearchDoc is SearchProjection<PetPassport> {
				vet?: VetSearchDoc;
			}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				passport?: PetPassportSearchDoc;
			}

			@route("/pet-passports")
			namespace PetPassports {
				@restResolver @get op getPetPassport(@path passportId: string): PetPassport;
			}

			@route("/vets")
			namespace Vets {
				@restResolver @get op getVet(@path vetId: string): Vet;
			}
		`);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		const resolved = resolveProjectionModel(runner.program, petCare);
		assert.ok(resolved);

		assert.deepEqual(collectJoinDependencies(runner.program, resolved), [
			{
				entity: "PetPassport",
				direction: "lookup",
				joinKey: "passportId",
				field: "passport",
			},
			{
				entity: "Vet",
				direction: "lookup",
				joinKey: "vetId",
				field: "passport.vet",
			},
		]);
	});

	it("names the document key a @searchAs rename moves the joined value to", async () => {
		const runner = await createRunner();
		await runner.diagnose(`
			${ENTITIES}

			@searchProjection
			@indexName("pet_care_v1")
			@dependsOn(PetPassport, "lookup", Pet.passportId)
			model PetCareSearchDoc is SearchProjection<Pet> {
				@searchAs("travelDocument")
				passport?: PetPassportSearchDoc;
			}

			${READS}
		`);

		const petCare = runner.program
			.getGlobalNamespaceType()
			.models.get("PetCareSearchDoc");
		assert.ok(petCare);

		const resolved = resolveProjectionModel(runner.program, petCare);
		assert.ok(resolved);

		assert.deepEqual(
			collectJoinDependencies(runner.program, resolved).map((x) => x.field),
			["travelDocument"],
		);
	});
});
