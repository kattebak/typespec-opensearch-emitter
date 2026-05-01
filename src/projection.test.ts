import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { isSearchable } from "./decorators.js";
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
