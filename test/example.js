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

test("emits TypeScript document type", async () => {
	const content = await readFile(
		"build/opensearch/product-search-doc-search-doc.ts",
		"utf8",
	);

	assert.equal(content.includes("export interface ProductSearchDoc"), true);
	assert.equal(content.includes("\tid: string;"), true);
	assert.equal(content.includes("\ttitle: string;"), true);
	assert.equal(content.includes("internalNotes"), false);
});

test("emits OpenSearch mapping JSON", async () => {
	const content = await readFile(
		"build/opensearch/product-search-doc-search-mapping.json",
		"utf8",
	);
	const parsed = JSON.parse(content);

	assert.equal(parsed.mappings.properties.id.type, "text");
	assert.equal(parsed.mappings.properties.title.type, "keyword");
	assert.equal(parsed.mappings.properties.title.fields, undefined);
});

test("emits index.ts barrel", async () => {
	const content = await readFile("build/opensearch/index.ts", "utf8");

	assert.equal(
		content.includes(
			'export type { ProductSearchDoc } from "./product-search-doc-search-doc.js";',
		),
		true,
	);
	assert.equal(
		content.includes('export const PRODUCT_INDEX_NAME = "products_v1";'),
		true,
	);
});
