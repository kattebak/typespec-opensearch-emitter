import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
		"build/opensearch/product-search-doc.ts",
		"utf8",
	);

	assert.equal(content.includes("export interface ProductSearchDoc"), true);
	assert.equal(content.includes("\tid: string;"), true);
	assert.equal(content.includes("\ttitle: string;"), true);
	assert.equal(content.includes("internalNotes"), false);
});

test("generated doc type compiles under tsc --noEmit", async () => {
	await writeFile(
		"build/opensearch/tsconfig.json",
		JSON.stringify(
			{
				compilerOptions: {
					module: "ESNext",
					moduleResolution: "bundler",
					target: "ES2020",
					strict: true,
					noEmit: true,
				},
				include: ["*.ts"],
			},
			null,
			2,
		),
	);

	await execFileAsync("npx", [
		"tsc",
		"--noEmit",
		"-p",
		"build/opensearch/tsconfig.json",
	]);
});
