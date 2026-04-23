import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("emits resolved search projections", async () => {
	const content = await readFile(
		"build/opensearch/opensearch-projections.json",
		"utf8",
	);
	const parsed = JSON.parse(content);

	assert.deepEqual(parsed, {
		projections: [
			{
				name: "ProductSearchDoc",
				sourceModel: "Product",
				indexName: "products_v1",
				fields: [
					{
						name: "id",
						optional: false,
						keyword: false,
						nested: false,
					},
					{
						name: "title",
						optional: false,
						keyword: true,
						nested: false,
						analyzer: "edge_ngram",
					},
				],
			},
		],
	});
});
