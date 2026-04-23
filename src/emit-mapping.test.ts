import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { emitMapping } from "./emit-mapping.js";
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

describe("mapping emitter", () => {
	it("emits OpenSearch mapping for projection", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Owner {
        @searchable @keyword name: string;
        email: string;
      }

      model Tag {
        @searchable name: string;
      }

      model Product {
        @searchable id: string;
        @searchable @keyword title: string;
        @searchable price: float64;
        @searchable releasedAt: plainDate;
        @searchable owner: Owner;
        @searchable @nested tags: Tag[];
      }

      model ProductSearchDoc is SearchProjection<Product> {
        @analyzer("edge_ngram") @boost(2)
        id: string;
      }
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		assert.equal(emitted.fileName, "product-search-doc-search-mapping.json");

		const parsed = JSON.parse(emitted.content);
		assert.equal(parsed.mappings.properties.title.type, "keyword");
		assert.equal(parsed.mappings.properties.id.type, "text");
		assert.equal(parsed.mappings.properties.id.analyzer, "edge_ngram");
		assert.equal(parsed.mappings.properties.id.boost, 2);
		assert.equal(parsed.mappings.properties.price.type, "double");
		assert.equal(parsed.mappings.properties.releasedAt.type, "date");
		assert.equal(parsed.mappings.properties.owner.type, "object");
		assert.deepEqual(Object.keys(parsed.mappings.properties.owner.properties), [
			"name",
		]);
		assert.equal(parsed.mappings.properties.tags.type, "nested");
		assert.deepEqual(Object.keys(parsed.mappings.properties.tags.properties), [
			"name",
		]);
	});
});
