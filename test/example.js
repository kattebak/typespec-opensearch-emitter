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
		"PersonSearchDoc",
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

test("emits `type <Name>` block for nested struct virtual sub-projections referenced from response shape", async () => {
	const sdl = await readFile(`${OUT_DIR}/person-search-doc.graphql`, "utf8");

	// Response object references the nested struct by name.
	assert.ok(sdl.includes("address: Address"));

	// `type Address { ... }` block emitted alongside the filter input.
	assert.ok(sdl.match(/^type Address \{/m));
	assert.ok(sdl.includes("country: String!"));
	assert.ok(sdl.includes("city: String!"));

	// Filter input still emitted (regression check).
	assert.ok(sdl.includes("input AddressSearchFilter {"));
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
	const prepare = await readFile(
		`${OUT_DIR}/pet-search-doc-fn-prepare.js`,
		"utf8",
	);

	assert.ok(sdl.includes("type TermBucket {"));
	assert.ok(sdl.includes("type PetSearchAggregations {"));
	assert.ok(sdl.includes("byAlias: [TermBucket!]!"));
	assert.ok(sdl.includes("uniqueAliasCount: Int!"));
	assert.ok(sdl.includes("missingNicknameCount: Int!"));
	assert.ok(sdl.includes("aggregations: PetSearchAggregations!"));
	// Singular scalar field whose name ends in 's' must keep the name verbatim
	// (issue #119). Pet.species is a scalar string, not Pet.species: string[].
	assert.ok(
		sdl.includes("bySpecies: [TermBucket!]!"),
		`expected bySpecies (preserved) in SDL; got:\n${sdl}`,
	);
	assert.ok(
		!sdl.includes("bySpecy:"),
		"emitter must not strip trailing 's' from singular fields",
	);

	// Aggs request shape lives in the prepare function; response mapping
	// lives in the resolver after-mapping (pipeline split — issue #105).
	assert.ok(prepare.includes("aggs:"));
	assert.ok(
		prepare.includes('byAlias: { terms: { field: "aliases.keyword" } }'),
	);
	assert.ok(
		prepare.includes(
			'uniqueAliasCount: { cardinality: { field: "aliases.keyword" } }',
		),
	);
	assert.ok(resolver.includes("aggregations: {"));
	assert.ok(resolver.includes("_a.byAlias?.buckets"));
});

test("emits SearchFilter input with filterable kinds and nested sub-filter", async () => {
	const sdl = await readFile(`${OUT_DIR}/pet-search-doc.graphql`, "utf8");
	const prepare = await readFile(
		`${OUT_DIR}/pet-search-doc-fn-prepare.js`,
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

	// FILTER_SPEC + applyFilterSpec live in the prepare function (pipeline
	// split — issue #105). FILTER_SPEC entries use compact single-letter keys
	// to fit under AppSync's 32 KB per-function code cap (issue #99). Range
	// emits ONE entry per field; the four bound input lookups (Gte/Lte/Gt/Lt)
	// are done at iteration time inside applyFilterSpec (issue #101).
	assert.ok(prepare.includes("const FILTER_SPEC = ["));
	assert.ok(prepare.includes("applyFilterSpec(FILTER_SPEC, searchFilter"));
	assert.ok(prepare.includes('i:"tags"'));
	assert.ok(prepare.includes('k:"nested"'));
	assert.ok(prepare.includes('p:"tags"'));
	assert.ok(prepare.includes('{i:"rank",k:"range"'));
	assert.ok(!prepare.includes('"rankGte"'));
});

test("emits nested-aware aggregations on nested sub-projections", async () => {
	const sdl = await readFile(`${OUT_DIR}/pet-search-doc.graphql`, "utf8");
	const resolver = await readFile(
		`${OUT_DIR}/pet-search-doc-resolver.js`,
		"utf8",
	);
	const prepare = await readFile(
		`${OUT_DIR}/pet-search-doc-fn-prepare.js`,
		"utf8",
	);

	assert.ok(sdl.includes("byTagName: [TermBucket!]!"));
	assert.ok(sdl.includes("uniqueTagNameCount: Int!"));
	assert.ok(sdl.includes("missingTagNoteCount: Int!"));

	// Nested aggs sharing a path are grouped under a single wrapper
	// (`_<path>` key) in the request (prepare function); the response
	// mapping in the resolver after-mapping reads the grouped shape — issue #105.
	assert.ok(
		prepare.includes(
			'_tags: { nested: { path: "tags" }, aggs: { byTagName: { terms: { field: "tags.name" } }, uniqueTagNameCount: { cardinality: { field: "tags.name" } }, missingTagNoteCount: { missing: { field: "tags.note.keyword" } } } }',
		),
	);
	assert.ok(
		resolver.includes("byTagName: (_a_tags.byTagName?.buckets ?? []).map"),
	);
	assert.ok(
		resolver.includes(
			"uniqueTagNameCount: _a_tags.uniqueTagNameCount?.value ?? 0",
		),
	);
	assert.ok(
		resolver.includes(
			"missingTagNoteCount: _a_tags.missingTagNoteCount?.doc_count ?? 0",
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
