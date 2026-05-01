import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { isSearchable } from "./decorators.js";
import { emitGraphQLResolver } from "./emit-graphql-resolver.js";
import { resolveProjectionModel } from "./projection.js";
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

describe("projection resolution", () => {
	it("resolves only searchable fields and merges projection overrides", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Tag {
        @searchable label: string;
        hidden: string;
      }

      model Product {
        @searchable @keyword name: string;
        @searchable tags: Tag[];
        hidden: string;
      }

      @indexName("products_v1")
      model ProductSearchDoc is SearchProjection<Product> {
        @analyzer("edge_ngram") @boost(2.0)
        name: string;

        @nested
        tags: Tag[];
      }
    `);

		assert.equal(diagnostics.length, 0);

		const projectionModel = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projectionModel);

		const resolved = resolveProjectionModel(runner.program, projectionModel);
		assert.ok(resolved);

		assert.equal(resolved.sourceModel.name, "Product");
		assert.equal(resolved.indexName, "products_v1");
		assert.deepEqual(
			resolved.fields.map((x) => x.name),
			["name", "tags"],
		);

		const nameField = resolved.fields.find((x) => x.name === "name");
		assert.ok(nameField);
		assert.equal(nameField.keyword, true);
		assert.equal(nameField.analyzer, "edge_ngram");
		assert.equal(nameField.boost, 2);

		const tagsField = resolved.fields.find((x) => x.name === "tags");
		assert.ok(tagsField);
		assert.equal(tagsField.nested, true);
	});

	it("returns undefined for non projection model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
      }
    `);
		assert.equal(diagnostics.length, 0);

		const model = runner.program.getGlobalNamespaceType().models.get("Product");
		assert.ok(model);
		assert.equal(resolveProjectionModel(runner.program, model), undefined);
	});

	it("keeps non-searchable source fields excluded", async () => {
		const runner = await createRunner();
		await runner.compile(`
      model Product {
        @searchable name: string;
        hidden: string;
      }

      model ProductSearchDoc is SearchProjection<Product> {}
    `);

		const source = runner.program
			.getGlobalNamespaceType()
			.models.get("Product");
		assert.ok(source);
		const hidden = source.properties.get("hidden");
		assert.ok(hidden);
		assert.equal(isSearchable(runner.program, hidden), false);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		assert.deepEqual(
			resolved.fields.map((x) => x.name),
			["name"],
		);
	});

	it("emits diagnostic for projection field not on source model", async () => {
		const runner = await createRunner();
		const _diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
      }

      model ProductSearchDoc is SearchProjection<Product> {
        name: string;
        phantom: string;
      }
    `);

		// diagnose() only runs the compiler; we must invoke resolveProjectionModel
		// to trigger projection-level diagnostics.
		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);
		resolveProjectionModel(runner.program, projection);

		const relevant = runner.program.diagnostics.filter(
			(d) =>
				d.code ===
				"@kattebak/typespec-opensearch-emitter/projection-field-not-on-source",
		);
		assert.equal(relevant.length, 1);
		assert.ok(relevant[0].message.includes("phantom"));
	});

	it("resolves sub-projection field with nested SearchProjection", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Tag {
        @searchable @keyword name: string;
        @searchable createdAt: utcDateTime;
        internalId: string;
      }

      model TagSearchDoc is SearchProjection<Tag> {}

      model Pet {
        @searchable name: string;
        @searchable @nested tags: Tag[];
      }

      @indexName("pets_v1")
      model PetSearchDoc is SearchProjection<Pet> {
        tags: TagSearchDoc[];
      }
    `);

		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("PetSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const tagsField = resolved.fields.find((x) => x.name === "tags");
		assert.ok(tagsField);
		assert.equal(tagsField.nested, true);
		assert.ok(tagsField.subProjection);
		assert.equal(tagsField.subProjection.projectionModel.name, "TagSearchDoc");
		assert.deepEqual(
			tagsField.subProjection.fields.map((x) => x.name),
			["name", "createdAt"],
		);
	});

	it("sub-projection excludes non-searchable fields from sub-model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Tag {
        @searchable @keyword name: string;
        internalId: string;
        secret: string;
      }

      model TagSearchDoc is SearchProjection<Tag> {}

      model Pet {
        @searchable name: string;
        @searchable @nested tags: Tag[];
      }

      @indexName("pets_v1")
      model PetSearchDoc is SearchProjection<Pet> {
        tags: TagSearchDoc[];
      }
    `);

		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("PetSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const tagsField = resolved.fields.find((x) => x.name === "tags");
		assert.ok(tagsField?.subProjection);
		const subFieldNames = tagsField.subProjection.fields.map((x) => x.name);
		assert.deepEqual(subFieldNames, ["name"]);
		assert.ok(!subFieldNames.includes("internalId"));
		assert.ok(!subFieldNames.includes("secret"));
	});

	it("emits diagnostic for projection field that exists on source but is not @searchable", async () => {
		const runner = await createRunner();
		const _diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
        hidden: string;
      }

      model ProductSearchDoc is SearchProjection<Product> {
        name: string;
        hidden: string;
      }
    `);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);
		resolveProjectionModel(runner.program, projection);

		const relevant = runner.program.diagnostics.filter(
			(d) =>
				d.code ===
				"@kattebak/typespec-opensearch-emitter/projection-field-not-on-source",
		);
		assert.equal(relevant.length, 1);
		assert.ok(relevant[0].message.includes("hidden"));
	});

	it("resolves @searchAs from projection override", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Person {
        @searchable @searchAs("srcName") givenName: string;
      }

      model PersonSearchDoc is SearchProjection<Person> {
        @searchAs("firstName") givenName: string;
      }
    `);

		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("PersonSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const field = resolved.fields.find((x) => x.name === "givenName");
		assert.ok(field);
		assert.equal(field.projectedName, "firstName");
	});

	it("resolves @searchAs from source when projection has none", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Person {
        @searchable @searchAs("firstName") givenName: string;
      }

      model PersonSearchDoc is SearchProjection<Person> {}
    `);

		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("PersonSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const field = resolved.fields.find((x) => x.name === "givenName");
		assert.ok(field);
		assert.equal(field.projectedName, "firstName");
	});

	it("uses original name when no @searchAs is present", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Person {
        @searchable givenName: string;
      }

      model PersonSearchDoc is SearchProjection<Person> {}
    `);

		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("PersonSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const field = resolved.fields.find((x) => x.name === "givenName");
		assert.ok(field);
		assert.equal(field.projectedName, undefined);
	});

	it("includes @searchable fields from spread model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Counterparty {
        @searchable @keyword name: string;
        @searchable email: string;
        hidden: string;
      }

      model CounterpartyDescribeResult {
        counterparty: Counterparty;
        @searchable score: float64;
      }

      model CpSearchDoc is SearchProjection<CounterpartyDescribeResult> {
        ...Counterparty;
        score: float64;
      }
    `);

		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("CpSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const fieldNames = resolved.fields.map((x) => x.name);
		assert.ok(fieldNames.includes("score"), "source field included");
		assert.ok(fieldNames.includes("name"), "spread @searchable field included");
		assert.ok(
			fieldNames.includes("email"),
			"spread @searchable field included",
		);
		assert.ok(
			!fieldNames.includes("hidden"),
			"non-searchable spread field excluded",
		);
	});

	it("spread fields inherit decorators from spread source", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Counterparty {
        @searchable @keyword name: string;
        @searchable @analyzer("edge_ngram") @boost(1.5) email: string;
      }

      model Wrapper {
        counterparty: Counterparty;
        @searchable score: float64;
      }

      model WrapperSearchDoc is SearchProjection<Wrapper> {
        ...Counterparty;
        score: float64;
      }
    `);

		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("WrapperSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const nameField = resolved.fields.find((x) => x.name === "name");
		assert.ok(nameField);
		assert.equal(nameField.keyword, true);

		const emailField = resolved.fields.find((x) => x.name === "email");
		assert.ok(emailField);
		assert.equal(emailField.analyzer, "edge_ngram");
		assert.equal(emailField.boost, 1.5);
	});

	it("excludes non-@searchable fields from spread model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Counterparty {
        @searchable name: string;
        hidden: string;
        secret: int32;
      }

      model Wrapper {
        @searchable score: float64;
      }

      model WrapperSearchDoc is SearchProjection<Wrapper> {
        ...Counterparty;
        score: float64;
      }
    `);

		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("WrapperSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const fieldNames = resolved.fields.map((x) => x.name);
		assert.deepEqual(fieldNames, ["score", "name"]);
	});

	it("emits diagnostic for spread field collision with source field", async () => {
		const runner = await createRunner();
		await runner.diagnose(`
      model Counterparty {
        @searchable name: string;
      }

      model Wrapper {
        @searchable name: string;
      }

      model WrapperSearchDoc is SearchProjection<Wrapper> {
        ...Counterparty;
      }
    `);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("WrapperSearchDoc");
		assert.ok(projection);
		resolveProjectionModel(runner.program, projection);

		const relevant = runner.program.diagnostics.filter(
			(d) =>
				d.code ===
				"@kattebak/typespec-opensearch-emitter/spread-field-collision",
		);
		assert.equal(relevant.length, 1);
		assert.ok(relevant[0].message.includes("name"));
	});

	it("spread fields work with @searchAs", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Counterparty {
        @searchable @searchAs("partyName") name: string;
      }

      model Wrapper {
        @searchable score: float64;
      }

      model WrapperSearchDoc is SearchProjection<Wrapper> {
        ...Counterparty;
        score: float64;
      }
    `);

		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("WrapperSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const nameField = resolved.fields.find((x) => x.name === "name");
		assert.ok(nameField);
		assert.equal(nameField.projectedName, "partyName");
	});

	it("spread fields preserve nested and array types", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Tag {
        @searchable @keyword label: string;
      }

      model Counterparty {
        @searchable @keyword name: string;
        @searchable @nested tags: Tag[];
      }

      model Wrapper {
        @searchable score: float64;
      }

      model WrapperSearchDoc is SearchProjection<Wrapper> {
        ...Counterparty;
        score: float64;
      }
    `);

		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("WrapperSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const tagsField = resolved.fields.find((x) => x.name === "tags");
		assert.ok(tagsField);
		assert.equal(tagsField.nested, true);

		const nameField = resolved.fields.find((x) => x.name === "name");
		assert.ok(nameField);
		assert.equal(nameField.keyword, true);
	});
});

describe("@searchInfer", () => {
	it("infers per-field defaults from each property's type", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Trade {
        id: string;
        @keyword counterpartyId: string;
        notional: float64;
        validFrom: utcDateTime;
        active: boolean;
        notes: string;
      }

      @searchInfer
      model TradeSearchDoc is SearchProjection<Trade> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("TradeSearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const byName = (n: string) => resolved.fields.find((f) => f.name === n);

		// utcDateTime → range filter, date_histogram(month) agg
		const validFrom = byName("validFrom");
		assert.ok(validFrom);
		assert.deepEqual(validFrom.filterables, ["range"]);
		assert.deepEqual(validFrom.aggregations, [
			{ kind: "date_histogram", options: { interval: "month" } },
		]);

		// numeric → range filter, sum/avg/min/max aggs
		const notional = byName("notional");
		assert.ok(notional);
		assert.deepEqual(notional.filterables, ["range"]);
		assert.deepEqual(notional.aggregations, [
			{ kind: "sum" },
			{ kind: "avg" },
			{ kind: "min" },
			{ kind: "max" },
		]);

		// string + @keyword → term/terms/exists filter, terms agg
		const counterpartyId = byName("counterpartyId");
		assert.ok(counterpartyId);
		assert.deepEqual(counterpartyId.filterables, ["term", "terms", "exists"]);
		assert.deepEqual(counterpartyId.aggregations, [{ kind: "terms" }]);

		// boolean → term + terms filter, no agg
		const active = byName("active");
		assert.ok(active);
		assert.deepEqual(active.filterables, ["term", "terms"]);
		assert.equal(active.aggregations, undefined);

		// free-text string (no @keyword) → no inference (still in projection)
		const notes = byName("notes");
		assert.ok(notes);
		assert.equal(notes.filterables, undefined);
		assert.equal(notes.aggregations, undefined);

		// Plain string with no decorators → no inference
		const id = byName("id");
		assert.ok(id);
		assert.equal(id.filterables, undefined);
		assert.equal(id.aggregations, undefined);
	});

	it("explicit decorators win per axis (filter explicit + agg inferred, and vice versa)", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Trade {
        notional: float64;
        validFrom: utcDateTime;
      }

      @searchInfer
      model TradeSearchDoc is SearchProjection<Trade> {
        @filterable("term") notional: float64;
        @aggregatable("sum") validFrom: utcDateTime;
      }
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("TradeSearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const notional = resolved.fields.find((f) => f.name === "notional");
		assert.ok(notional);
		// Filter axis explicit → only "term".
		assert.deepEqual(notional.filterables, ["term"]);
		// Agg axis inferred → numeric metric quartet.
		assert.deepEqual(notional.aggregations, [
			{ kind: "sum" },
			{ kind: "avg" },
			{ kind: "min" },
			{ kind: "max" },
		]);

		const validFrom = resolved.fields.find((f) => f.name === "validFrom");
		assert.ok(validFrom);
		// Filter axis inferred → range.
		assert.deepEqual(validFrom.filterables, ["range"]);
		// Agg axis explicit → only sum.
		assert.deepEqual(validFrom.aggregations, [{ kind: "sum" }]);
	});

	it("@searchSkip excludes a field when it has no other decorators", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Trade {
        notional: float64;
        @searchSkip secret: float64;
      }

      @searchInfer
      model TradeSearchDoc is SearchProjection<Trade> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("TradeSearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const notional = resolved.fields.find((f) => f.name === "notional");
		assert.ok(notional);
		assert.deepEqual(notional.filterables, ["range"]);

		// @searchSkip blocks the inference path; without other decorators
		// the field has no reason to be in the projection.
		assert.equal(
			resolved.fields.find((f) => f.name === "secret"),
			undefined,
		);
	});

	it("@searchSkip preserves @searchable field in response shape but suppresses inference", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Trade {
        notional: float64;
        @searchable @searchSkip auditTrail: string;
      }

      @searchInfer
      model TradeSearchDoc is SearchProjection<Trade> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("TradeSearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const auditTrail = resolved.fields.find((f) => f.name === "auditTrail");
		assert.ok(auditTrail, "@searchable @searchSkip field stays in projection");
		assert.equal(auditTrail.searchable, true);
		// Inference suppressed even though it would normally apply (free-text
		// string would infer nothing anyway, so this also covers @keyword).
		assert.equal(auditTrail.filterables, undefined);
		assert.equal(auditTrail.aggregations, undefined);
	});

	it("infers sortable on keyword/numeric/date/boolean fields, not on free-text or @nested", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Tag {
        @searchable name: string;
      }
      model Trade {
        @keyword counterpartyId: string;
        notional: float64;
        validFrom: utcDateTime;
        active: boolean;
        notes: string;                  // free-text — not sortable
        @nested tags: Tag[];            // nested — not sortable
      }
      @searchInfer
      model TradeSearchDoc is SearchProjection<Trade> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("TradeSearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const byName = (n: string) => resolved.fields.find((f) => f.name === n);

		assert.equal(byName("counterpartyId")?.sortable, true);
		assert.equal(byName("notional")?.sortable, true);
		assert.equal(byName("validFrom")?.sortable, true);
		assert.equal(byName("active")?.sortable, true);
		assert.equal(byName("notes")?.sortable, false);
		assert.equal(byName("tags")?.sortable, false);
	});

	it("@sortable on a field is honored even without @searchInfer", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Trade {
        @searchable name: string;
        @searchable @sortable @keyword counterpartyId: string;
      }
      model TradeSearchDoc is SearchProjection<Trade> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("TradeSearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		assert.equal(
			resolved.fields.find((f) => f.name === "counterpartyId")?.sortable,
			true,
		);
		assert.equal(
			resolved.fields.find((f) => f.name === "name")?.sortable,
			false,
		);
	});

	it("auto-recurses into struct fields when parent is @searchInfer (issue #98)", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Address {
        @keyword country: string;
        @keyword city: string;
        postalCode: string;
      }
      model Counterparty {
        @keyword id: string;
        address: Address;
      }
      @searchInfer
      model CounterpartySearchDoc is SearchProjection<Counterparty> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("CounterpartySearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const address = resolved.fields.find((f) => f.name === "address");
		assert.ok(address);
		assert.ok(
			address.subProjection,
			"struct field should get an auto-built virtual sub-projection",
		);
		assert.equal(address.subProjection.projectionModel.name, "Address");
		const subFieldNames = address.subProjection.fields.map((f) => f.name);
		assert.deepEqual(subFieldNames, ["country", "city", "postalCode"]);

		const country = address.subProjection.fields.find(
			(f) => f.name === "country",
		);
		assert.ok(country);
		assert.deepEqual(country.filterables, ["term", "terms", "exists"]);
	});

	it("recurses through @nested struct arrays when parent is @searchInfer", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Tag {
        @keyword tagId: string;
        @keyword label: string;
      }
      model Counterparty {
        @keyword id: string;
        @nested tags: Tag[];
      }
      @searchInfer
      model CounterpartySearchDoc is SearchProjection<Counterparty> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("CounterpartySearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const tags = resolved.fields.find((f) => f.name === "tags");
		assert.ok(tags);
		assert.equal(tags.nested, true);
		assert.ok(tags.subProjection);
		const subFieldNames = tags.subProjection.fields.map((f) => f.name);
		assert.deepEqual(subFieldNames, ["tagId", "label"]);
	});

	it("two-level struct recursion with @searchInfer", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Coordinates {
        latitude: float64;
        longitude: float64;
      }
      model Address {
        @keyword country: string;
        coords: Coordinates;
      }
      model Place {
        address: Address;
      }
      @searchInfer
      model PlaceSearchDoc is SearchProjection<Place> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("PlaceSearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const address = resolved.fields.find((f) => f.name === "address");
		assert.ok(address?.subProjection);
		const coords = address.subProjection.fields.find(
			(f) => f.name === "coords",
		);
		assert.ok(coords?.subProjection, "second-level struct recursion");
		const coordsFieldNames = coords.subProjection.fields.map((f) => f.name);
		assert.deepEqual(coordsFieldNames, ["latitude", "longitude"]);
	});

	it("recurses into a nested type whose model has @searchInfer, even when the parent projection lacks it (issue #102)", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      @searchInfer
      model Address {
        @keyword country: string;
        @keyword city: string;
      }
      model Location {
        @keyword name: string;
        address: Address;
      }
      model LocationSearchDoc is SearchProjection<Location> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("LocationSearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		// LocationSearchDoc has no @searchInfer of its own. Without #102,
		// the address sub-projection wouldn't be built at all because the
		// parent walker only recurses when the parent is @searchInfer.
		const address = resolved.fields.find((f) => f.name === "address");
		assert.ok(
			address?.subProjection,
			"address should auto-recurse because Address has @searchInfer",
		);
		const subFieldNames = address.subProjection.fields.map((f) => f.name);
		assert.deepEqual(subFieldNames, ["country", "city"]);
	});

	it("@searchSkip on a struct field opts the entire sub-tree out of recursion", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model SecretBlock {
        @keyword token: string;
      }
      model Counterparty {
        @keyword id: string;
        @searchable @searchSkip secret: SecretBlock;
      }
      @searchInfer
      model CounterpartySearchDoc is SearchProjection<Counterparty> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("CounterpartySearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const secret = resolved.fields.find((f) => f.name === "secret");
		assert.ok(secret, "@searchable field stays in the projection");
		assert.equal(
			secret.subProjection,
			undefined,
			"@searchSkip suppresses virtual sub-projection",
		);
	});

	it("without @searchInfer, fields with no decorators stay excluded", async () => {
		const runner = await createRunner();
		await runner.diagnose(`
      model Trade {
        notional: float64;
        @searchable name: string;
      }

      model TradeSearchDoc is SearchProjection<Trade> {}
    `);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("TradeSearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		// Only `name` (which is @searchable) should be present.
		assert.deepEqual(
			resolved.fields.map((f) => f.name),
			["name"],
		);
	});
});

describe("emitted resolver size budget", () => {
	it("stays under AppSync's 32 KB code cap on a wide @searchInfer projection (issues #99, #101)", async () => {
		// Consumer's shape from the v1.22.0 incident: 4 nested-record types
		// each carrying @searchInfer (Address / PhoneNumberRecord / EmailRecord
		// / PersonRecord), plus 4 simpler sub-models, all reachable from the
		// root Counterparty projection. Pre-#101 this hit 38 KB and the
		// AppSync deploy was rejected.
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      @searchInfer model Address { @keyword country: string; @keyword city: string; postalCode: string; }
      @searchInfer model PhoneNumberRecord { @keyword number: string; @keyword countryCode: string; }
      @searchInfer model EmailRecord { @keyword email: string; @keyword type: string; }
      @searchInfer model PersonRecord { @keyword name: string; @keyword role: string; }
      model Tag { @keyword tagId: string; @keyword label: string; }
      model Group { @keyword groupId: string; @keyword name: string; }
      model Approval { @keyword type: string; validFrom: utcDateTime; validTo: utcDateTime; }
      model Reference { @keyword refId: string; @keyword source: string; }
      model Location { address: Address; @keyword name: string; }
      model Contact { name: PersonRecord; phone: PhoneNumberRecord; email: EmailRecord; }
      model Counterparty {
        @keyword id: string;
        @keyword name: string;
        notional: float64;
        rank: int32;
        active: boolean;
        createdAt: utcDateTime;
        @nested locations: Location[];
        @nested contacts: Contact[];
        @nested tags: Tag[];
        @nested groups: Group[];
        @nested approvals: Approval[];
        @nested references: Reference[];
      }
      @searchInfer
      model CounterpartySearchDoc is SearchProjection<Counterparty> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("CounterpartySearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const result = emitGraphQLResolver(resolved, {
			defaultPageSize: 20,
			maxPageSize: 100,
			trackTotalHitsUpTo: 10000,
		});

		// AppSync APPSYNC_JS hard cap on resolver source code.
		const APPSYNC_CODE_CAP = 32 * 1024;
		assert.ok(
			result.content.length < APPSYNC_CODE_CAP,
			`emitted resolver is ${result.content.length} bytes — exceeds AppSync's ${APPSYNC_CODE_CAP}-byte cap. Wide projections need further shrink work.`,
		);
	});
});
