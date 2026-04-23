import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OUT_DIR = "build/opensearch-emit";

test("emits projection metadata for multiple projections", async () => {
	const content = await readFile(
		`${OUT_DIR}/opensearch-projections.json`,
		"utf8",
	);
	const parsed = JSON.parse(content);

	assert.equal(parsed.projections.length, 2);
	assert.deepEqual(parsed.projections.map((x) => x.name).sort(), [
		"PetPublicSearchDoc",
		"PetSearchDoc",
	]);

	const petSearch = parsed.projections.find((x) => x.name === "PetSearchDoc");
	assert.ok(petSearch);
	assert.equal(petSearch.indexName, "pets_v1");
	const nameField = petSearch.fields.find((x) => x.name === "name");
	assert.ok(nameField);
	assert.equal(nameField.analyzer, "edge_ngram");
	assert.equal(nameField.boost, 2);
});

test("emits mapping files with expected field mappings", async () => {
	const searchContent = await readFile(
		`${OUT_DIR}/pet-search-doc-search-mapping.json`,
		"utf8",
	);
	const publicContent = await readFile(
		`${OUT_DIR}/pet-public-search-doc-search-mapping.json`,
		"utf8",
	);
	const searchMapping = JSON.parse(searchContent).mappings.properties;
	const publicMapping = JSON.parse(publicContent).mappings.properties;

	assert.equal(searchMapping.name.type, "text");
	assert.equal(searchMapping.name.analyzer, "edge_ngram");
	assert.equal(searchMapping.name.boost, 2);
	assert.equal(searchMapping.name.fields.keyword.type, "keyword");

	assert.equal(searchMapping.species.type, "keyword");
	assert.equal(searchMapping.birthDate.type, "date");
	assert.equal(searchMapping.createdAt.type, "date");
	assert.equal(searchMapping.rank.type, "long");
	assert.equal(searchMapping.stock.type, "long");
	assert.equal(searchMapping.score.type, "double");
	assert.equal(searchMapping.active.type, "boolean");
	assert.equal(searchMapping.tags.type, "nested");
	assert.equal(searchMapping.tags.properties.name.type, "keyword");
	assert.equal(searchMapping.owner.type, "object");
	assert.equal(searchMapping.owner.properties.name.type, "keyword");
	assert.equal(searchMapping.aliases.type, "text");

	assert.equal(publicMapping.name.type, "keyword");
	assert.equal(publicMapping.name.fields, undefined);
});

test("emits doc types and index constants", async () => {
	const indexTs = await readFile(`${OUT_DIR}/index.ts`, "utf8");
	const petSearchDoc = await readFile(`${OUT_DIR}/pet-search-doc.ts`, "utf8");
	const petPublicSearchDoc = await readFile(
		`${OUT_DIR}/pet-public-search-doc.ts`,
		"utf8",
	);

	assert.equal(
		indexTs.includes('export const PET_SEARCH_DOC_INDEX_NAME = "pets_v1";'),
		true,
	);
	assert.equal(
		indexTs.includes(
			'export const PET_PUBLIC_SEARCH_DOC_INDEX_NAME = "pet_public_search_doc";',
		),
		true,
	);
	assert.equal(petSearchDoc.includes("breed?: string;"), true);
	assert.equal(petSearchDoc.includes("internalNotes"), false);
	assert.equal(
		petPublicSearchDoc.includes("export interface PetPublicSearchDoc"),
		true,
	);
});

test("generated output compiles and exports constants", async () => {
	await writeFile(
		`${OUT_DIR}/tsconfig.json`,
		JSON.stringify(
			{
				compilerOptions: {
					module: "NodeNext",
					moduleResolution: "NodeNext",
					target: "ES2020",
					strict: true,
					outDir: "./dist",
				},
				include: ["*.ts"],
			},
			null,
			2,
		),
	);

	await execFileAsync("npx", ["tsc", "-p", `${OUT_DIR}/tsconfig.json`]);
	const indexModule = await import(
		pathToFileURL(`${OUT_DIR}/dist/index.js`).href
	);

	assert.equal(indexModule.PET_SEARCH_DOC_INDEX_NAME, "pets_v1");
	assert.equal(
		indexModule.PET_PUBLIC_SEARCH_DOC_INDEX_NAME,
		"pet_public_search_doc",
	);
});
