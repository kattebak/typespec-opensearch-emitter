import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import {
	getAnalyzer,
	getBoost,
	getIndexName,
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

	it("stores values for all decorator state accessors", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      @indexName("products_v1")
      model ProductSearchDoc is SearchProjection<Product> {
        @searchable @keyword @nested @analyzer("edge_ngram") @boost(2.0)
        name: string;
      }

      model Product {
        @searchable name: string;
      }
    `);

		assert.equal(diagnostics.length, 0);

		const ns = runner.program.getGlobalNamespaceType();
		const projection = ns.models.get("ProductSearchDoc");
		assert.ok(projection);

		const name = projection.properties.get("name");
		assert.ok(name);

		assert.equal(isSearchable(runner.program, name), true);
		assert.equal(isKeyword(runner.program, name), true);
		assert.equal(isNested(runner.program, name), true);
		assert.equal(getAnalyzer(runner.program, name), "edge_ngram");
		assert.equal(getBoost(runner.program, name), 2);
		assert.equal(getIndexName(runner.program, projection), "products_v1");
	});
});
