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

	// Issue #130 — analyzed-field filter kinds. The projection's `name` field
	// carries @analyzer("edge_ngram") @filterable("prefix", "match").
	//
	// (a) GraphQL: the SearchFilter input gains String operators for the
	//     analyzed field.
	assert.ok(sdl.includes("namePrefix: String"));
	assert.ok(sdl.includes("nameMatch: String"));

	// (b) FILTER_SPEC targets the ANALYZED field (`name`), NOT `name.keyword` —
	//     so the edge-ngram analyzer is exercised by the query (bypasses the
	//     needsKeywordSuffix routing applied to term/terms/range).
	assert.ok(prepare.includes('{i:"namePrefix",k:"prefix",f:"name"}'));
	assert.ok(prepare.includes('{i:"nameMatch",k:"match",f:"name"}'));
	assert.ok(!prepare.includes('f:"name.keyword"'));

	// (c) The resolver emits `prefix` / `match` OpenSearch queries (not a
	//     `.keyword` term).
	assert.ok(
		prepare.includes("outFilters.push({ prefix: { [node.f]: value } })"),
	);
	assert.ok(
		prepare.includes("outFilters.push({ match: { [node.f]: value } })"),
	);
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

test("nested-only projections emit a stripped SDL fragment + doc type, no top-level wiring (issue #123)", async () => {
	// ApprovalSearchDoc is `is SearchProjection<Approval>` but lacks
	// `@searchProjection`; it is referenced by PetSearchDoc as an array
	// element. The fix here: emit just the response object so the parent's
	// `approvals: [ApprovalSearchDoc!]!` reference resolves, and skip the
	// top-level concepts that would imply a Query field / OS index that
	// doesn't exist (the original AppSync "Not Found" trap).
	const sdl = await readFile(`${OUT_DIR}/approval-search-doc.graphql`, "utf8");
	assert.ok(sdl.includes("type ApprovalSearchDoc {"));
	assert.ok(sdl.includes("type: String!"));
	assert.ok(sdl.includes("grantedBy: String!"));
	// No Connection / Edge / PageInfo — those exist only to pair with a
	// Query field returning a Connection.
	assert.ok(!sdl.includes("ApprovalSearchDocConnection"));
	assert.ok(!sdl.includes("ApprovalSearchDocEdge"));
	assert.ok(!sdl.includes("PageInfo"));
	// No filter / sort inputs either — same logic.
	assert.ok(!sdl.includes("ApprovalSearchDocFilter"));
	assert.ok(!sdl.includes("ApprovalSearchFilter"));
	assert.ok(!sdl.includes("ApprovalSortInput"));

	// Doc type still emitted — useful as a TS shape for the array element.
	const docType = await readFile(`${OUT_DIR}/approval-search-doc.ts`, "utf8");
	assert.ok(docType.includes("ApprovalSearchDoc"));

	// Manifest must NOT contain a searchApproval entry — this is the
	// original bug. The downstream resolver would target the non-existent
	// `approval_search_doc` index and AppSync would return "Not Found".
	const manifest = JSON.parse(
		await readFile(`${OUT_DIR}/graphql-resolvers.json`, "utf8"),
	);
	const names = manifest.resolvers.map((r) => r.queryFieldName);
	assert.ok(
		!names.includes("searchApproval"),
		"nested-only projections must not appear in the resolver manifest",
	);
	assert.ok(names.includes("searchPet"), "top-level projections still listed");

	// No mapping JSON either (no backing OS index).
	await assert.rejects(
		readFile(`${OUT_DIR}/approval-search-doc-search-mapping.json`, "utf8"),
		"nested-only projections must not emit a mapping file",
	);
	// No resolver file.
	await assert.rejects(
		readFile(`${OUT_DIR}/approval-search-doc-resolver.js`, "utf8"),
		"nested-only projections must not emit a resolver",
	);

	// PetSearchDoc references the type via the array element.
	const petSdl = await readFile(`${OUT_DIR}/pet-search-doc.graphql`, "utf8");
	assert.ok(petSdl.includes("approvals: [ApprovalSearchDoc!]!"));

	// And the index.ts must NOT export an APPROVAL_SEARCH_DOC_INDEX_NAME
	// constant — there's no index to reference.
	const indexTs = await readFile(`${OUT_DIR}/index.ts`, "utf8");
	assert.ok(!indexTs.includes("APPROVAL_SEARCH_DOC_INDEX_NAME"));
});

test("emits @graphqlDirectives on response-path types and surfaces them in the manifest (issue #121)", async () => {
	const sdl = await readFile(`${OUT_DIR}/tag-search-doc.graphql`, "utf8");
	const manifest = JSON.parse(
		await readFile(`${OUT_DIR}/graphql-resolvers.json`, "utf8"),
	);

	// Every type along the response path gets the directive — AppSync rejects
	// the response otherwise. PageInfo lives in the same SDL fragment so it
	// gets the same suffix; consumers dedupe across fragments.
	assert.ok(
		sdl.includes("type TagSearchDoc @aws_cognito_user_pools @aws_iam {"),
	);
	assert.ok(
		sdl.includes(
			"type TagSearchDocConnection @aws_cognito_user_pools @aws_iam {",
		),
	);
	assert.ok(
		sdl.includes("type TagSearchDocEdge @aws_cognito_user_pools @aws_iam {"),
	);
	assert.ok(sdl.includes("type PageInfo @aws_cognito_user_pools @aws_iam {"));
	assert.ok(
		sdl.includes(
			"type TagSearchAggregations @aws_cognito_user_pools @aws_iam {",
		),
	);
	assert.ok(sdl.includes("type TermBucket @aws_cognito_user_pools @aws_iam {"));
	// Input types (filters) sit on argument paths; AppSync auth doesn't walk
	// them, and the issue scope is response-path only.
	assert.ok(sdl.includes("input TagSearchDocFilter {\n"));

	// Manifest carries the directive list on the affected projection only;
	// untouched projections keep the pre-issue-121 manifest shape.
	const tagEntry = manifest.resolvers.find(
		(r) => r.projection === "TagSearchDoc",
	);
	assert.ok(tagEntry);
	assert.deepEqual(tagEntry.queryFieldDirectives, [
		"@aws_cognito_user_pools",
		"@aws_iam",
	]);
	const petEntry = manifest.resolvers.find(
		(r) => r.projection === "PetSearchDoc",
	);
	assert.ok(petEntry);
	assert.ok(
		!("queryFieldDirectives" in petEntry),
		"projections without an override must omit queryFieldDirectives",
	);
});

test("does not apply directives to other projections' SDL fragments (per-model scoping)", async () => {
	// Confirm the override is scoped to the decorated projection — AppSync
	// schemas often mix auth modes per-projection, so a directive bleeding
	// into a sibling fragment would silently widen access.
	const petSdl = await readFile(`${OUT_DIR}/pet-search-doc.graphql`, "utf8");
	const personSdl = await readFile(
		`${OUT_DIR}/person-search-doc.graphql`,
		"utf8",
	);
	assert.ok(!petSdl.includes("@aws_cognito_user_pools"));
	assert.ok(!petSdl.includes("@aws_iam"));
	assert.ok(!personSdl.includes("@aws_cognito_user_pools"));
	assert.ok(!personSdl.includes("@aws_iam"));
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
