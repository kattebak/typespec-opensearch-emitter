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

	assert.deepEqual(parsed.projections.map((x) => x.name).sort(), [
		"PetPublicSearchDoc",
		"PetSearchDoc",
		"TagSearchDoc",
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

test("emits graphql aggregation types and resolver block", async () => {
	const sdl = await readFile(`${OUT_DIR}/pet-search-doc.graphql`, "utf8");
	const resolver = await readFile(
		`${OUT_DIR}/pet-search-doc-resolver.js`,
		"utf8",
	);

	assert.ok(sdl.includes("type TermBucket {"));
	assert.ok(sdl.includes("type PetSearchAggregations {"));
	assert.ok(sdl.includes("byAlias: [TermBucket!]!"));
	assert.ok(sdl.includes("uniqueAliasCount: Int!"));
	assert.ok(sdl.includes("missingNicknameCount: Int!"));
	assert.ok(sdl.includes("aggregations: PetSearchAggregations!"));

	assert.ok(resolver.includes("aggs:"));
	assert.ok(
		resolver.includes('byAlias: { terms: { field: "aliases.keyword" } }'),
	);
	assert.ok(
		resolver.includes(
			'uniqueAliasCount: { cardinality: { field: "aliases.keyword" } }',
		),
	);
	assert.ok(resolver.includes("aggregations: {"));
	assert.ok(resolver.includes("parsedBody.aggregations?.byAlias?.buckets"));
});

test("emits SearchFilter input with filterable kinds and nested sub-filter", async () => {
	const sdl = await readFile(`${OUT_DIR}/pet-search-doc.graphql`, "utf8");
	const resolver = await readFile(
		`${OUT_DIR}/pet-search-doc-resolver.js`,
		"utf8",
	);

	assert.ok(sdl.includes("input PetSearchFilter {"));
	assert.ok(sdl.includes("species: String"));
	assert.ok(sdl.includes("speciesNot: String"));
	assert.ok(sdl.includes("birthDateGte: String"));
	assert.ok(sdl.includes("birthDateLt: String"));
	assert.ok(sdl.includes("rankGte: Int"));
	assert.ok(sdl.includes("rankLte: Int"));
	assert.ok(sdl.includes("nicknameExists: Boolean"));
	assert.ok(sdl.includes("tags: TagSearchFilter"));
	assert.ok(sdl.includes("input TagSearchFilter {"));
	assert.ok(sdl.includes("name: String"));
	assert.ok(sdl.includes("nameNot: String"));
	assert.ok(sdl.includes("noteExists: Boolean"));

	assert.ok(resolver.includes("const FILTER_SPEC = ["));
	assert.ok(resolver.includes("applyFilterSpec(FILTER_SPEC, searchFilter"));
	// FILTER_SPEC entries use compact single-letter keys to fit under
	// AppSync's 32 KB resolver code cap (issue #99).
	assert.ok(resolver.includes('i:"tags"'));
	assert.ok(resolver.includes('k:"nested"'));
	assert.ok(resolver.includes('p:"tags"'));
	assert.ok(resolver.includes('i:"rankGte"'));
	assert.ok(resolver.includes('b:"gte"'));
});

test("emits nested-aware aggregations on nested sub-projections", async () => {
	const sdl = await readFile(`${OUT_DIR}/pet-search-doc.graphql`, "utf8");
	const resolver = await readFile(
		`${OUT_DIR}/pet-search-doc-resolver.js`,
		"utf8",
	);

	assert.ok(sdl.includes("byTagName: [TermBucket!]!"));
	assert.ok(sdl.includes("uniqueTagNameCount: Int!"));
	assert.ok(sdl.includes("missingTagNoteCount: Int!"));

	assert.ok(
		resolver.includes(
			'byTagName: { nested: { path: "tags" }, aggs: { inner: { terms: { field: "tags.name" } } } }',
		),
	);
	assert.ok(
		resolver.includes(
			'uniqueTagNameCount: { nested: { path: "tags" }, aggs: { inner: { cardinality: { field: "tags.name" } } } }',
		),
	);
	assert.ok(
		resolver.includes(
			'missingTagNoteCount: { nested: { path: "tags" }, aggs: { inner: { missing: { field: "tags.note.keyword" } } } }',
		),
	);
	assert.ok(
		resolver.includes(
			"byTagName: (parsedBody.aggregations?.byTagName?.inner?.buckets ?? []).map",
		),
	);
	assert.ok(
		resolver.includes(
			"uniqueTagNameCount: parsedBody.aggregations?.uniqueTagNameCount?.inner?.value ?? 0",
		),
	);
	assert.ok(
		resolver.includes(
			"missingTagNoteCount: parsedBody.aggregations?.missingTagNoteCount?.inner?.doc_count ?? 0",
		),
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
