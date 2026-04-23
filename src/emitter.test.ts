import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { __test } from "./emitter.js";
import type { ResolvedProjection } from "./projection.js";
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

describe("emitter model collection", () => {
	it("collects only SearchProjection<T> models", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
        hidden: string;
      }

      model ProductSearchDoc is SearchProjection<Product> {}
      model Inventory {}
    `);

		assert.equal(diagnostics.length, 0);

		const models = __test.collectProjectionModels(
			runner.program,
			runner.program.getGlobalNamespaceType(),
		);
		assert.deepEqual(
			models.map((x) => x.name),
			["ProductSearchDoc"],
		);
	});

	it("serializes resolved projections", () => {
		const projections = [
			{
				projectionModel: { name: "ProductSearchDoc" },
				sourceModel: { name: "Product" },
				indexName: "product_search_doc",
				fields: [
					{
						name: "name",
						optional: false,
						keyword: true,
						nested: false,
						analyzer: "edge_ngram",
						boost: 2,
					},
				],
			},
		] as unknown as ResolvedProjection[];
		const serialized = __test.serializeProjections(projections);

		assert.deepEqual(serialized, {
			projections: [
				{
					name: "ProductSearchDoc",
					sourceModel: "Product",
					indexName: "product_search_doc",
					fields: [
						{
							name: "name",
							optional: false,
							keyword: true,
							nested: false,
							analyzer: "edge_ngram",
							boost: 2,
						},
					],
				},
			],
		});
	});
});
