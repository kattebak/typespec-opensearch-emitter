import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import {
	getAnalyzer,
	getBoost,
	getIgnoreAbove,
	getIndexName,
	getIndexSettings,
	getSearchAs,
	isKeyword,
	isNested,
	isSearchable,
} from "./decorators.js";
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

describe("decorators", () => {
	it("marks property as searchable", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
        description: string;
      }
    `);

		assert.equal(diagnostics.length, 0);

		const product = runner.program
			.getGlobalNamespaceType()
			.models.get("Product");
		assert.ok(product);

		const name = product.properties.get("name");
		assert.ok(name);
		assert.equal(isSearchable(runner.program, name), true);

		const description = product.properties.get("description");
		assert.ok(description);
		assert.equal(isSearchable(runner.program, description), false);
	});

	it("stores values for decorators and resolves explicit index name", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Tag {
        @searchable value: string;
      }

      model Product {
        @searchable name: string;
        @searchable tags: Tag[];
      }

      @indexName("products_v1")
      model ProductSearchDoc is SearchProjection<Product> {
        @searchable @keyword @analyzer("edge_ngram") @boost(2.0)
        name: string;

        @searchable @nested
        tags: Tag[];
      }
    `);

		assert.equal(diagnostics.length, 0);

		const ns = runner.program.getGlobalNamespaceType();
		const projection = ns.models.get("ProductSearchDoc");
		assert.ok(projection);

		const name = projection.properties.get("name");
		assert.ok(name);
		const tags = projection.properties.get("tags");
		assert.ok(tags);

		assert.equal(isSearchable(runner.program, name), true);
		assert.equal(isKeyword(runner.program, name), true);
		assert.equal(getAnalyzer(runner.program, name), "edge_ngram");
		assert.equal(getBoost(runner.program, name), 2);

		assert.equal(isSearchable(runner.program, tags), true);
		assert.equal(isNested(runner.program, tags), true);

		assert.equal(getIndexName(runner.program, projection), "products_v1");
	});

	it("derives default index name from model name", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model CounterpartySearchDoc is SearchProjection<Counterparty> {
        @searchable id: string;
      }

      model Counterparty {
        @searchable id: string;
      }
    `);

		assert.equal(diagnostics.length, 0);

		const model = runner.program
			.getGlobalNamespaceType()
			.models.get("CounterpartySearchDoc");
		assert.ok(model);
		assert.equal(
			getIndexName(runner.program, model),
			"counterparty_search_doc",
		);
	});

	it("emits diagnostic for invalid keyword target", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @keyword rank: int32;
      }
    `);

		const codes = diagnostics.map((x) => x.code);
		assert.equal(hasDiagnosticCode(codes, "string-property-required"), true);
	});

	it("emits diagnostic for invalid analyzer target", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @analyzer("edge_ngram") rank: int32;
      }
    `);

		const codes = diagnostics.map((x) => x.code);
		assert.equal(hasDiagnosticCode(codes, "string-property-required"), true);
	});

	it("emits diagnostic for invalid nested target", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @nested name: string;
      }
    `);

		const codes = diagnostics.map((x) => x.code);
		assert.equal(hasDiagnosticCode(codes, "nested-array-model-required"), true);
	});

	it("emits diagnostic for zero boost", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @boost(0) name: string;
      }
    `);

		const codes = diagnostics.map((x) => x.code);
		assert.equal(hasDiagnosticCode(codes, "positive-boost-required"), true);
	});

	it("emits diagnostic for negative boost", async () => {
		// Negative factors are invalid and should produce a diagnostic.
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @boost(-1) name: string;
      }
    `);

		const codes = diagnostics.map((x) => x.code);
		assert.equal(hasDiagnosticCode(codes, "positive-boost-required"), true);
	});

	it("stores and retrieves @indexSettings with valid JSON", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Pet {
        @searchable name: string;
      }

      @indexSettings("{\\"analysis\\":{\\"analyzer\\":{\\"my_analyzer\\":{\\"type\\":\\"custom\\"}}}}") 
      model PetSearchDoc is SearchProjection<Pet> {}
    `);

		assert.equal(diagnostics.length, 0);

		const model = runner.program
			.getGlobalNamespaceType()
			.models.get("PetSearchDoc");
		assert.ok(model);

		const settings = getIndexSettings(runner.program, model);
		assert.ok(settings);
		assert.deepEqual(settings, {
			analysis: { analyzer: { my_analyzer: { type: "custom" } } },
		});
	});

	it("emits diagnostic for @indexSettings with invalid JSON", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Pet {
        @searchable name: string;
      }

      @indexSettings("not valid json")
      model PetSearchDoc is SearchProjection<Pet> {}
    `);

		const codes = diagnostics.map((x) => x.code);
		assert.equal(hasDiagnosticCode(codes, "invalid-index-settings-json"), true);
	});

	it("stores and retrieves @ignoreAbove value", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @ignoreAbove(512) @searchable name: string;
      }
    `);

		assert.equal(diagnostics.length, 0);

		const product = runner.program
			.getGlobalNamespaceType()
			.models.get("Product");
		assert.ok(product);

		const name = product.properties.get("name");
		assert.ok(name);
		assert.equal(getIgnoreAbove(runner.program, name), 512);
	});

	it("emits diagnostic for zero ignoreAbove", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @ignoreAbove(0) name: string;
      }
    `);

		const codes = diagnostics.map((x) => x.code);
		assert.equal(
			hasDiagnosticCode(codes, "positive-ignore-above-required"),
			true,
		);
	});

	it("stores and retrieves @searchAs value", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchAs("firstName") @searchable givenName: string;
      }
    `);

		assert.equal(diagnostics.length, 0);

		const product = runner.program
			.getGlobalNamespaceType()
			.models.get("Product");
		assert.ok(product);

		const givenName = product.properties.get("givenName");
		assert.ok(givenName);
		assert.equal(getSearchAs(runner.program, givenName), "firstName");
	});

	it("emits diagnostic for empty @searchAs", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchAs("") name: string;
      }
    `);

		const codes = diagnostics.map((x) => x.code);
		assert.equal(
			hasDiagnosticCode(codes, "non-empty-search-as-required"),
			true,
		);
	});
});
