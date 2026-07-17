import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Type } from "@typespec/compiler";
import {
	DEFAULT_AUTO_DATE_HISTOGRAM_BUCKETS,
	emitGraphQLResolver,
	MIN_AUTO_DATE_HISTOGRAM_BUCKETS,
	PER_REQUEST_BUCKET_BUDGET,
} from "./emit-graphql-resolver.js";
import type { ResolvedProjection } from "./projection.js";

function makeProjection(
	overrides: Partial<{
		name: string;
		indexName: string;
		fields: ResolvedProjection["fields"];
	}> = {},
): ResolvedProjection {
	return {
		projectionModel: { name: overrides.name ?? "PetSearchDoc" },
		sourceModel: { name: "Pet" },
		indexName: overrides.indexName ?? "pets_v1",
		fields: overrides.fields ?? [],
	} as unknown as ResolvedProjection;
}

function makeSubProjection(
	name: string,
	fields: ResolvedProjection["fields"],
): ResolvedProjection {
	return {
		projectionModel: { name },
		sourceModel: { name },
		fields,
	} as unknown as ResolvedProjection;
}

function makeField(
	overrides: Partial<{
		name: string;
		projectedName: string;
		keyword: boolean;
		nested: boolean;
		optional: boolean;
		searchable: boolean;
		analyzer: string;
		type: Type;
		aggregations: unknown;
		filterables: ResolvedProjection["fields"][0]["filterables"];
		subProjection: ResolvedProjection;
	}> = {},
) {
	return {
		name: overrides.name ?? "field",
		projectedName: overrides.projectedName,
		keyword: overrides.keyword ?? false,
		nested: overrides.nested ?? false,
		optional: overrides.optional ?? false,
		searchable: overrides.searchable ?? true,
		analyzer: overrides.analyzer,
		type:
			overrides.type ??
			({
				kind: "Scalar",
				name: "string",
			} as unknown as Type),
		aggregations: liftAggregations(overrides.aggregations),
		filterables: overrides.filterables,
		subProjection: overrides.subProjection,
	} as unknown as ResolvedProjection["fields"][0];
}

function liftAggregations(
	raw: unknown,
): ResolvedProjection["fields"][0]["aggregations"] {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	return raw.map((entry) =>
		typeof entry === "string" ? { kind: entry } : entry,
	) as ResolvedProjection["fields"][0]["aggregations"];
}

/**
 * Loads the buildQuery function from a prepare-function source string.
 * Strips the `import { util } from "@aws-appsync/utils"` line, swaps `export`
 * for plain declarations, then evaluates and returns the captured buildQuery.
 */
function loadBuildQuery(
	resolverSource: string,
): (
	queryText: string | undefined,
	filter: unknown,
	searchFilter: unknown,
) => unknown {
	const stripped = resolverSource
		.replace(/^import \{ util \} from "@aws-appsync\/utils";?\n?/m, "")
		.replace(/^export function /gm, "function ");
	const factory = new Function(`${stripped}\nreturn buildQuery;`) as () => (
		queryText: string | undefined,
		filter: unknown,
		searchFilter: unknown,
	) => unknown;
	return factory();
}

/**
 * Evaluates a prepare- (or monolithic-) resolver `request(ctx)` and returns
 * the OS body it stashes/builds. Pipeline `prepare` writes to
 * `ctx.stash.queryBody`; the monolithic request returns `{ params: { body } }`.
 * This helper handles both shapes so tests can assert on body contents under
 * different `ctx.info.selectionSetList` scenarios.
 */
function evalRequestBody(
	resolverSource: string,
	info: { selectionSetList: string[] },
	args: Record<string, unknown> = {},
): Record<string, unknown> {
	const stripped = resolverSource
		.replace(/^import \{ util \} from "@aws-appsync\/utils";?\n?/m, "")
		.replace(/^export function /gm, "function ");
	const factory = new Function("util", `${stripped}\nreturn request;`) as (
		util: unknown,
	) => (ctx: unknown) => unknown;
	const utilStub = {
		base64Decode: (s: string) => Buffer.from(s, "base64").toString("utf8"),
		base64Encode: (s: string) => Buffer.from(s, "utf8").toString("base64"),
		error: (msg: string) => {
			throw new Error(msg);
		},
	};
	const request = factory(utilStub);
	const ctx = {
		args,
		info,
		stash: {} as Record<string, unknown>,
	};
	const ret = request(ctx) as { params?: { body?: Record<string, unknown> } };
	if (ctx.stash.queryBody) {
		return ctx.stash.queryBody as Record<string, unknown>;
	}
	if (ret && ret.params && ret.params.body) {
		return ret.params.body;
	}
	throw new Error(
		`request function did not produce a body: ret=${JSON.stringify(ret)}, stash=${JSON.stringify(ctx.stash)}`,
	);
}

type UtilError = Error & {
	errorType?: string;
	data?: unknown;
	errorInfo?: unknown;
};

/**
 * Evaluates an emitted `response(ctx)` against a stub `util`, mirroring the
 * AppSync runtime closely enough for issue #150: `util.error` interrupts
 * evaluation, so it throws here and carries the errorType/data/errorInfo
 * through for assertions. The stub takes all four documented arguments
 * (`message`, `errorType`, `data`, `errorInfo`) so a diagnostic parked in the
 * wrong slot is visible to a test rather than silently dropped at runtime.
 * Returns the handler's value on the success path.
 */
function evalResponse(source: string, ctx: unknown): unknown {
	const stripped = source
		.replace(/^import \{ util \} from "@aws-appsync\/utils";?\n?/m, "")
		.replace(/^export function /gm, "function ");
	const factory = new Function("util", `${stripped}\nreturn response;`) as (
		util: unknown,
	) => (ctx: unknown) => unknown;
	const utilStub = {
		base64Decode: (s: string) => Buffer.from(s, "base64").toString("utf8"),
		base64Encode: (s: string) => Buffer.from(s, "utf8").toString("base64"),
		error: (
			message: string,
			errorType?: string,
			data?: unknown,
			errorInfo?: unknown,
		) => {
			const err: UtilError = new Error(message);
			err.errorType = errorType;
			err.data = data;
			err.errorInfo = errorInfo;
			throw err;
		},
	};
	return factory(utilStub)(ctx);
}

function captureResponseError(source: string, ctx: unknown): UtilError {
	try {
		evalResponse(source, ctx);
	} catch (err) {
		return err as UtilError;
	}
	throw new Error("response(ctx) returned without raising an error");
}

type EmitResult = Awaited<ReturnType<typeof emitGraphQLResolver>>;

/**
 * Returns a concatenation of every emitted file (resolver-level + each
 * pipeline function). Lets assertions that don't care WHICH file something
 * lands in just substring-check the union.
 */
function combinedContent(result: EmitResult): string {
	return [result.content, ...result.functions.map((fn) => fn.content)].join(
		"\n",
	);
}

function prepareFunctionContent(result: EmitResult): string {
	const fn = result.functions.find((f) => f.name === "prepare");
	if (!fn) throw new Error("missing prepare function");
	return fn.content;
}

function searchFunctionContent(result: EmitResult): string {
	const fn = result.functions.find((f) => f.name === "search");
	if (!fn) throw new Error("missing search function");
	return fn.content;
}

// Pipeline-mode options for the legacy assertions in this file. Setting the
// monolithic threshold to 0 forces the emitter into pipeline mode (issue
// #112) so the existing pipeline-shape tests stay valid. Monolithic-mode and
// threshold-flip tests live further down.
const defaultOptions = {
	defaultPageSize: 20,
	maxPageSize: 100,
	trackTotalHitsUpTo: 10000,
	monolithicThresholdBytes: 0,
};

describe("emitGraphQLResolver", () => {
	it("generates resolver file with correct name", async () => {
		const projection = makeProjection({ fields: [] });
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.equal(result.fileName, "pet-search-doc-resolver.js");
		assert.equal(result.queryFieldName, "searchPet");
	});

	it("emits a pipeline shape: resolver + prepare (NONE) + search (OPENSEARCH) functions", async () => {
		const projection = makeProjection({ fields: [] });
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.equal(result.functions.length, 2);
		assert.deepEqual(
			result.functions.map((f) => ({ name: f.name, ds: f.dataSource })),
			[
				{ name: "prepare", ds: "NONE" },
				{ name: "search", ds: "OPENSEARCH" },
			],
		);
		assert.equal(result.functions[0].fileName, "pet-search-doc-fn-prepare.js");
		assert.equal(result.functions[1].fileName, "pet-search-doc-fn-search.js");
		// Resolver-level file holds the after-mapping (response shape).
		assert.ok(result.content.includes("export function response"));
		assert.ok(result.content.includes("ctx.prev.result"));
		// Prepare function holds the FILTER_SPEC + walker + body assembly,
		// stashing the OS body for the search function.
		assert.ok(result.functions[0].content.includes("ctx.stash.queryBody"));
		// Search function reads the stash and issues the OS HTTP request.
		assert.ok(result.functions[1].content.includes("ctx.stash.queryBody"));
		assert.ok(
			result.functions[1].content.includes('operation: "GET"'),
			"search function must issue an OpenSearch GET",
		);
	});

	it("includes index name in request path", async () => {
		const projection = makeProjection({
			indexName: "pets_v1",
			fields: [],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		// Index name lives in the search-datasource pipeline function only.
		assert.ok(searchFunctionContent(result).includes("/pets_v1/_search"));
	});

	it("includes text fields in multi_match", async () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" }), makeField({ name: "breed" })],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(combinedContent(result).includes('"name","breed"'));
	});

	it("includes keyword fields in filter logic", async () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "species", keyword: true }),
				makeField({ name: "status", keyword: true }),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(combinedContent(result).includes('"species","status"'));
	});

	it("wraps a nested sub-projection's searchable fields in a nested clause and takes dotted paths through an object sub-projection", async () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({
					name: "tags",
					nested: true,
					subProjection: makeSubProjection("TagSearchDoc", [
						makeField({ name: "label" }),
					]),
				}),
				makeField({
					name: "owner",
					subProjection: makeSubProjection("OwnerSearchDoc", [
						makeField({ name: "fullName" }),
					]),
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		const query = loadBuildQuery(prepareFunctionContent(result))(
			"rex",
			undefined,
			undefined,
		);

		assert.deepEqual(query, {
			bool: {
				must: [
					{
						bool: {
							should: [
								{
									multi_match: {
										query: "rex",
										fields: ["name", "owner.fullName"],
										type: "best_fields",
									},
								},
								{
									nested: {
										path: "tags",
										score_mode: "max",
										query: {
											multi_match: {
												query: "rex",
												fields: ["tags.label"],
												type: "best_fields",
											},
										},
									},
								},
							],
							minimum_should_match: 1,
						},
					},
				],
			},
		});
	});

	it("keeps the flat multi_match byte-for-byte when no nested sub-projection is searchable", async () => {
		const withoutNested = makeProjection({
			fields: [makeField({ name: "name" }), makeField({ name: "description" })],
		});
		const withInertNested = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({ name: "description" }),
				makeField({
					name: "tags",
					nested: true,
					subProjection: makeSubProjection("TagSearchDoc", [
						// Filter-only and keyword fields carry no free-text surface,
						// so the nested wrapper must stay off.
						makeField({ name: "tagId", keyword: true }),
						makeField({ name: "note", searchable: false }),
					]),
				}),
			],
		});

		const baseline = combinedContent(
			await emitGraphQLResolver(withoutNested, defaultOptions),
		);
		const actual = combinedContent(
			await emitGraphQLResolver(withInertNested, defaultOptions),
		);

		assert.ok(
			baseline.includes(`		musts.push({
			multi_match: {
				query: queryText,
				fields: ["name","description"],
				type: "best_fields",
			},
		});`),
		);
		assert.ok(!baseline.includes("minimum_should_match"));
		assert.equal(actual, baseline);
	});

	it("honours @analyzer on a nested field by querying the analyzed path, not .keyword", async () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({
					name: "references",
					nested: true,
					subProjection: makeSubProjection("ReferenceSearchDoc", [
						makeField({ name: "value", analyzer: "edge_ngram_analyzer" }),
					]),
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		const query = loadBuildQuery(prepareFunctionContent(result))(
			"ABC",
			undefined,
			undefined,
		) as {
			bool: {
				must: [{ bool: { should: [unknown, { nested: { query: unknown } }] } }];
			};
		};

		// An @analyzer only takes effect on the analyzed field itself; the
		// `.keyword` sub-field is not analyzed. The nested clause must query
		// `references.value` bare for edge-ngram partial matching to work.
		assert.deepEqual(query.bool.must[0].bool.should[1].nested.query, {
			multi_match: {
				query: "ABC",
				fields: ["references.value"],
				type: "best_fields",
			},
		});
	});

	it("groups searchable fields by their innermost nested ancestor", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "references",
					nested: true,
					subProjection: makeSubProjection("ReferenceSearchDoc", [
						makeField({ name: "value" }),
						// An object sub-projection inside a nested one stays in the
						// same hidden document: it extends the path but opens no
						// second nested clause.
						makeField({
							name: "issuer",
							subProjection: makeSubProjection("IssuerSearchDoc", [
								makeField({ name: "code" }),
							]),
						}),
					]),
				}),
				makeField({
					name: "tags",
					nested: true,
					subProjection: makeSubProjection("TagSearchDoc", [
						makeField({ name: "label" }),
					]),
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		const query = loadBuildQuery(prepareFunctionContent(result))(
			"rex",
			undefined,
			undefined,
		);

		// No root-document text field, so no flat clause — only the two
		// nested groups, each naming its own path.
		assert.deepEqual(query, {
			bool: {
				must: [
					{
						bool: {
							should: [
								{
									nested: {
										path: "references",
										score_mode: "max",
										query: {
											multi_match: {
												query: "rex",
												fields: ["references.value", "references.issuer.code"],
												type: "best_fields",
											},
										},
									},
								},
								{
									nested: {
										path: "tags",
										score_mode: "max",
										query: {
											multi_match: {
												query: "rex",
												fields: ["tags.label"],
												type: "best_fields",
											},
										},
									},
								},
							],
							minimum_should_match: 1,
						},
					},
				],
			},
		});
	});

	it("resolves nested text fields through @searchAs projected names", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "references",
					projectedName: "refs",
					nested: true,
					subProjection: makeSubProjection("ReferenceSearchDoc", [
						makeField({ name: "value", projectedName: "code" }),
					]),
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(
			combinedContent(result).includes(
				'NESTED_TEXT_GROUPS = [["refs",["refs.code"]]]',
			),
		);
	});

	it("excludes non-searchable filter-only fields from text_fields and keyword_fields but includes them in FILTER_SPEC", async () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({
					name: "counterpartyId",
					keyword: true,
					searchable: false,
					filterables: ["term"],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(
			combinedContent(result).includes('fields: ["name"]'),
			"counterpartyId is not @searchable so must not appear in multi_match fields",
		);
		assert.ok(
			combinedContent(result).includes(
				'{i:"counterpartyId",k:"term",f:"counterpartyId"}',
			),
			"FILTER_SPEC must carry the term filter for the non-searchable field (compact-key form)",
		);
	});

	it("excludes non-searchable agg-only fields from text/keyword sets but includes them in aggs", async () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({
					name: "type",
					keyword: true,
					searchable: false,
					aggregations: ["terms"],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(combinedContent(result).includes('fields: ["name"]'));
		assert.ok(
			combinedContent(result).includes("byType:"),
			"aggregation should still be emitted for non-searchable agg-only field",
		);
	});

	it("respects custom page size and track_total_hits options", async () => {
		const projection = makeProjection({ fields: [] });
		const result = await emitGraphQLResolver(projection, {
			...defaultOptions,
			defaultPageSize: 10,
			maxPageSize: 50,
			trackTotalHitsUpTo: 5000,
		});

		assert.ok(combinedContent(result).includes("args.first || 10"));
		assert.ok(combinedContent(result).includes("50)"));
		assert.ok(combinedContent(result).includes("track_total_hits: 5000"));
	});

	it("uses projectedName for field references", async () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name", projectedName: "displayName" })],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(combinedContent(result).includes('"displayName"'));
		assert.ok(!combinedContent(result).includes('"name"'));
	});

	it("has no import statements except aws-appsync/utils", async () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		// Each emitted file (resolver + each pipeline function) has at most
		// one import — and only `@aws-appsync/utils`.
		const allFiles = [
			result.content,
			...result.functions.map((f) => f.content),
		];
		for (const file of allFiles) {
			const imports = file.split("\n").filter((l) => l.startsWith("import "));
			assert.ok(imports.length <= 1);
			if (imports.length === 1) {
				assert.ok(imports[0].includes("@aws-appsync/utils"));
			}
		}
	});

	it("falls back to _score desc then _id asc when sortBy arg is omitted", async () => {
		const projection = makeProjection({ fields: [] });
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(combinedContent(result).includes('{ _score: "desc" }'));
		assert.ok(combinedContent(result).includes('{ _id: "asc" }'));
		// New: resolver routes sort through buildSort(args.sortBy) so callers
		// can override the fallback.
		assert.ok(combinedContent(result).includes("buildSort(args.sortBy)"));
		assert.ok(combinedContent(result).includes("function buildSort(sortBy)"));
	});

	it("buildSort honors sortBy arg with multiple fields, appending _id tie-break", async () => {
		const projection = makeProjection({ fields: [] });
		const source = prepareFunctionContent(
			await emitGraphQLResolver(projection, defaultOptions),
		);
		const stripped = source
			.replace(/^import \{ util \} from "@aws-appsync\/utils";?\n?/m, "")
			.replace(/^export function /gm, "function ");
		const buildSort = new Function(`${stripped}\nreturn buildSort;`)() as (
			sortBy: unknown,
		) => unknown;

		assert.deepEqual(
			buildSort([
				{ field: "createdAt", direction: "DESC" },
				{ field: "name", direction: "ASC" },
			]),
			[{ createdAt: "desc" }, { name: "asc" }, { _id: "asc" }],
		);
		// Single field — still gets _id tie-break.
		assert.deepEqual(buildSort([{ field: "rank", direction: "ASC" }]), [
			{ rank: "asc" },
			{ _id: "asc" },
		]);
		// Empty / undefined — fallback to _score, _id.
		assert.deepEqual(buildSort([]), [{ _score: "desc" }, { _id: "asc" }]);
		assert.deepEqual(buildSort(undefined), [
			{ _score: "desc" },
			{ _id: "asc" },
		]);
	});

	it("buildSort suffixes .keyword on @sortable text fields, leaves keyword/numeric/date/boolean fields untouched (closes #126)", async () => {
		// Matrix of sortable fields:
		//   name           — text (string, no @keyword) → must sort on name.keyword
		//   counterpartyId — keyword string             → sort on bare path
		//   notional       — numeric                    → sort on bare path
		//   validFrom      — date                       → sort on bare path
		//   active         — boolean                    → sort on bare path
		// OpenSearch rejects sort against a `text` field with
		// UserIllegalArgumentException, so the resolver must target the
		// `.keyword` subfield that emit-mapping always attaches to text fields.
		const projection = makeProjection({
			fields: [
				makeField({
					name: "name",
					searchable: true,
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
				makeField({
					name: "counterpartyId",
					keyword: true,
					searchable: true,
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
				makeField({
					name: "notional",
					searchable: true,
					type: { kind: "Scalar", name: "float64" } as unknown as Type,
				}),
				makeField({
					name: "validFrom",
					searchable: true,
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
				}),
				makeField({
					name: "active",
					searchable: true,
					type: { kind: "Scalar", name: "boolean" } as unknown as Type,
				}),
			],
		});
		// Mark all five sortable. makeField does not expose `sortable`, so set it
		// directly on the field shape.
		for (const f of projection.fields) {
			(f as unknown as { sortable: boolean }).sortable = true;
		}

		const source = prepareFunctionContent(
			await emitGraphQLResolver(projection, defaultOptions),
		);
		const stripped = source
			.replace(/^import \{ util \} from "@aws-appsync\/utils";?\n?/m, "")
			.replace(/^export function /gm, "function ");
		const buildSort = new Function(`${stripped}\nreturn buildSort;`)() as (
			sortBy: unknown,
		) => unknown;

		// text field → .keyword suffix
		assert.deepEqual(buildSort([{ field: "name", direction: "ASC" }]), [
			{ "name.keyword": "asc" },
			{ _id: "asc" },
		]);
		// @keyword string → bare path
		assert.deepEqual(
			buildSort([{ field: "counterpartyId", direction: "DESC" }]),
			[{ counterpartyId: "desc" }, { _id: "asc" }],
		);
		// numeric / date / boolean → bare path
		assert.deepEqual(buildSort([{ field: "notional", direction: "DESC" }]), [
			{ notional: "desc" },
			{ _id: "asc" },
		]);
		assert.deepEqual(buildSort([{ field: "validFrom", direction: "ASC" }]), [
			{ validFrom: "asc" },
			{ _id: "asc" },
		]);
		assert.deepEqual(buildSort([{ field: "active", direction: "ASC" }]), [
			{ active: "asc" },
			{ _id: "asc" },
		]);

		// Multi-field sortBy: each entry routes independently.
		assert.deepEqual(
			buildSort([
				{ field: "name", direction: "ASC" },
				{ field: "notional", direction: "DESC" },
				{ field: "counterpartyId", direction: "ASC" },
			]),
			[
				{ "name.keyword": "asc" },
				{ notional: "desc" },
				{ counterpartyId: "asc" },
				{ _id: "asc" },
			],
		);
	});

	it("buildSort emits monolithic mode also suffixes .keyword on text sort fields", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "name",
					searchable: true,
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
			],
		});
		(projection.fields[0] as unknown as { sortable: boolean }).sortable = true;

		// Default options (no monolithicThresholdBytes override) → monolithic mode.
		const result = await emitGraphQLResolver(projection, {
			defaultPageSize: 20,
			maxPageSize: 100,
			trackTotalHitsUpTo: 10000,
		});
		assert.equal(result.mode, "monolithic");
		// The TEXT_SORT_FIELDS literal must include "name", and the buildSort
		// body must consult it.
		assert.ok(result.content.includes('TEXT_SORT_FIELDS = ["name"]'));
		assert.ok(result.content.includes('".keyword"'));
	});

	it("buildSort leaves text fields that aren't @sortable out of TEXT_SORT_FIELDS", async () => {
		// A text field that's only @searchable (not @sortable) is still mapped
		// as text+.keyword by emit-mapping, but it should NOT appear in
		// TEXT_SORT_FIELDS — the GraphQL schema won't expose it as a sort
		// option, and we don't want the resolver to silently rewrite a sort
		// path the caller crafted by hand.
		const projection = makeProjection({
			fields: [
				makeField({
					name: "notes",
					searchable: true,
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
			],
		});
		// sortable left as false (default).

		const result = await emitGraphQLResolver(projection, defaultOptions);
		assert.ok(combinedContent(result).includes("TEXT_SORT_FIELDS = []"));
	});

	it("uses search_after for cursor pagination", async () => {
		const projection = makeProjection({ fields: [] });
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(combinedContent(result).includes("search_after"));
		assert.ok(combinedContent(result).includes("base64Decode"));
		assert.ok(combinedContent(result).includes("base64Encode"));
	});

	// A projection with several independent top-level aggregations, including
	// the date_histogram that makes riding-along aggregations expensive.
	function multiAggProjection() {
		return makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					aggregations: ["terms", "cardinality"],
				}),
				makeField({
					name: "rank",
					aggregations: [{ kind: "date_histogram", options: {} }],
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
				}),
			],
		});
	}

	// A projection mixing a top-level aggregation with two aggregations under a
	// single @nested path, so the `_tags` wrapper's presence can be pinned to
	// the caller's selection.
	function nestedAggProjection() {
		const subProjection = {
			projectionModel: { name: "TagSearchDoc" },
			sourceModel: { name: "Tag" },
			indexName: "tags",
			fields: [
				makeField({ name: "name", keyword: true, aggregations: ["terms"] }),
				makeField({ name: "note", optional: true, aggregations: ["missing"] }),
			],
		} as unknown as ResolvedProjection;

		return makeProjection({
			fields: [
				makeField({ name: "species", keyword: true, aggregations: ["terms"] }),
				makeField({
					name: "tags",
					nested: true,
					subProjection,
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});
	}

	it("omits aggs block when no aggregations", async () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(!combinedContent(result).includes("aggs:"));
		assert.ok(!combinedContent(result).includes("body.aggs"));
		assert.ok(!combinedContent(result).includes("AGG_SPEC"));
		assert.ok(!combinedContent(result).includes("buildAggs"));
		assert.ok(!combinedContent(result).includes("aggregations:"));
	});

	it("emits an AGG_SPEC entry per aggregation when fields have aggregations", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					aggregations: ["terms"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Scalar", name: "string" } },
					} as unknown as Type,
				}),
				makeField({
					name: "species",
					keyword: true,
					aggregations: ["terms"],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(combinedContent(result).includes("const AGG_SPEC = ["));
		assert.ok(
			combinedContent(result).includes(
				'{n:"byTag",a:{ terms: { field: "tags.keyword" } }}',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				'{n:"bySpecies",a:{ terms: { field: "species" } }}',
			),
		);
	});

	it("assembles body.aggs from ctx.info.selectionSetList", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					aggregations: ["terms"],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		const combined = combinedContent(result);

		// buildAggs must read the caller's selection. APPSYNC_JS forbids regex
		// and try/catch — keep the check to plain string comparisons.
		assert.ok(
			combined.includes("const aggs = buildAggs(ctx.info.selectionSetList);"),
			`body.aggs must be assembled from ctx.info.selectionSetList; got:\n${combined}`,
		);
		assert.ok(
			combined.includes('selectionSetList.indexOf("aggregations/" + spec.n)'),
			"buildAggs must match each spec entry against the caller's selection",
		);
		assert.ok(
			combined.includes("if (aggs) {"),
			"body.aggs assignment must be inside `if (aggs)` block",
		);
		// Sanity: the gate appears BEFORE `body.aggs = ` in the request function.
		const gateIdx = combined.indexOf("if (aggs)");
		const assignIdx = combined.indexOf("body.aggs = ");
		assert.ok(gateIdx >= 0 && assignIdx >= 0 && gateIdx < assignIdx);
	});

	it("request body produced without selecting aggregations contains no aggs key", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					aggregations: ["terms"],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: ["edges", "totalCount"],
		});
		assert.equal(
			Object.hasOwn(body, "aggs"),
			false,
			`body must NOT contain aggs when caller did not select aggregations; got body=${JSON.stringify(body)}`,
		);
	});

	it("request body produced WITH aggregations selection contains the aggs object", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					aggregations: ["terms"],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: [
				"edges",
				"totalCount",
				"aggregations",
				"aggregations/bySpecies",
				"aggregations/bySpecies/key",
			],
		});
		assert.ok(
			body.aggs && typeof body.aggs === "object",
			`body.aggs must be present when caller selects aggregations; got body=${JSON.stringify(body)}`,
		);
		const aggs = body.aggs as Record<string, unknown>;
		assert.ok(
			"bySpecies" in aggs,
			`body.aggs.bySpecies must be present; got aggs=${JSON.stringify(aggs)}`,
		);
	});

	it("sends only the aggregations the caller selected", async () => {
		// Issue #150 — every aggregation used to ride along with any
		// `aggregations` selection, so one aggregation OpenSearch rejects
		// (an unbounded date_histogram over a far-future sentinel date) failed
		// every aggregation query on the projection, including those that never
		// referenced it.
		const result = await emitGraphQLResolver(
			multiAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: [
				"edges",
				"totalCount",
				"aggregations",
				"aggregations/bySpecies",
				"aggregations/bySpecies/key",
			],
		});
		assert.deepEqual(Object.keys(body.aggs as Record<string, unknown>), [
			"bySpecies",
		]);
	});

	it("sends every aggregation the caller selected", async () => {
		const result = await emitGraphQLResolver(
			multiAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: [
				"aggregations",
				"aggregations/bySpecies",
				"aggregations/uniqueSpeciesCount",
				"aggregations/byRankOverTime",
			],
		});
		assert.deepEqual(Object.keys(body.aggs as Record<string, unknown>).sort(), [
			"byRankOverTime",
			"bySpecies",
			"uniqueSpeciesCount",
		]);
	});

	it("omits the aggs key when the caller selects no aggregation field", async () => {
		const result = await emitGraphQLResolver(
			multiAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: ["edges", "edges/node", "totalCount", "pageInfo"],
		});
		assert.equal(
			Object.hasOwn(body, "aggs"),
			false,
			`body must NOT contain aggs; got body=${JSON.stringify(body)}`,
		);
	});

	it("builds a nested agg group only for the selected children", async () => {
		const result = await emitGraphQLResolver(
			nestedAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: [
				"aggregations",
				"aggregations/byTagName",
				"aggregations/byTagName/key",
			],
		});
		assert.deepEqual(body.aggs, {
			_tags: {
				nested: { path: "tags" },
				aggs: { byTagName: { terms: { field: "tags.name" } } },
			},
		});
	});

	it("omits a nested agg group when none of its children are selected", async () => {
		const result = await emitGraphQLResolver(
			nestedAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: ["aggregations", "aggregations/bySpecies"],
		});
		assert.deepEqual(body.aggs, {
			bySpecies: { terms: { field: "species" } },
		});
	});

	it("groups every selected child of a nested path under one wrapper", async () => {
		const result = await emitGraphQLResolver(
			nestedAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: [
				"aggregations",
				"aggregations/byTagName",
				"aggregations/missingTagNoteCount",
			],
		});
		assert.deepEqual(body.aggs, {
			_tags: {
				nested: { path: "tags" },
				aggs: {
					byTagName: { terms: { field: "tags.name" } },
					missingTagNoteCount: { missing: { field: "tags.note.keyword" } },
				},
			},
		});
	});

	// `selectionSetList` reports an aliased field under its alias only — the
	// schema field name never appears — so an aliased aggregation matches no
	// AGG_SPEC entry. Narrowing on that would send no aggs and answer with empty
	// buckets the caller cannot distinguish from a real empty result, since the
	// response side reads defensively (`parsedBody.aggregations || {}`). These
	// pin the fallback that keeps aliased queries whole.
	it("sends every aggregation when the caller aliases an aggregation field", async () => {
		const result = await emitGraphQLResolver(
			multiAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: [
				"totalCount",
				"aggregations",
				"aggregations/speciesBuckets",
				"aggregations/speciesBuckets/key",
				"aggregations/speciesBuckets/count",
			],
		});
		assert.deepEqual(Object.keys(body.aggs as Record<string, unknown>).sort(), [
			"byRankOverTime",
			"bySpecies",
			"uniqueSpeciesCount",
		]);
	});

	it("sends every aggregation when an alias is mixed with a named aggregation", async () => {
		const result = await emitGraphQLResolver(
			multiAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: [
				"aggregations",
				"aggregations/bySpecies",
				"aggregations/bySpecies/key",
				"aggregations/rankOverTime",
				"aggregations/rankOverTime/key",
			],
		});
		assert.deepEqual(Object.keys(body.aggs as Record<string, unknown>).sort(), [
			"byRankOverTime",
			"bySpecies",
			"uniqueSpeciesCount",
		]);
	});

	it("builds every nested agg group when the caller aliases an aggregation field", async () => {
		const result = await emitGraphQLResolver(
			nestedAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: [
				"aggregations",
				"aggregations/tagNames",
				"aggregations/tagNames/key",
			],
		});
		assert.deepEqual(body.aggs, {
			bySpecies: { terms: { field: "species" } },
			_tags: {
				nested: { path: "tags" },
				aggs: {
					byTagName: { terms: { field: "tags.name" } },
					missingTagNoteCount: { missing: { field: "tags.note.keyword" } },
				},
			},
		});
	});

	// `aggregations` is an object type, so Apollo (`addTypename: true` by
	// default), Amplify and Relay inject `__typename` into its selection set.
	// `__typename` is not an alias, and reading it as one would switch the
	// narrowing off for exactly those clients.
	it("__typename under aggregations does not widen the selection", async () => {
		const result = await emitGraphQLResolver(
			multiAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: [
				"totalCount",
				"aggregations",
				"aggregations/__typename",
				"aggregations/bySpecies",
				"aggregations/bySpecies/__typename",
				"aggregations/bySpecies/key",
			],
		});
		assert.deepEqual(Object.keys(body.aggs as Record<string, unknown>), [
			"bySpecies",
		]);
	});

	it("sends every aggregation when __typename accompanies an aliased aggregation", async () => {
		const result = await emitGraphQLResolver(
			multiAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: [
				"aggregations",
				"aggregations/__typename",
				"aggregations/speciesBuckets",
				"aggregations/speciesBuckets/__typename",
				"aggregations/speciesBuckets/key",
			],
		});
		assert.deepEqual(Object.keys(body.aggs as Record<string, unknown>).sort(), [
			"byRankOverTime",
			"bySpecies",
			"uniqueSpeciesCount",
		]);
	});

	it("aliasing a sub-field of an aggregation does not widen the selection", async () => {
		// `bySpecies { k: key }` aliases below the aggregation name, which stays
		// resolvable — narrowing must still apply.
		const result = await emitGraphQLResolver(
			multiAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: [
				"aggregations",
				"aggregations/bySpecies",
				"aggregations/bySpecies/k",
				"aggregations/bySpecies/n",
			],
		});
		assert.deepEqual(Object.keys(body.aggs as Record<string, unknown>), [
			"bySpecies",
		]);
	});

	it("omits the aggs key when an alias sits outside the aggregations selection", async () => {
		// A field aliased at the top level must not read as an aggregation alias.
		const result = await emitGraphQLResolver(
			multiAggProjection(),
			defaultOptions,
		);

		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: ["count: totalCount", "rows", "rows/node"],
		});
		assert.equal(
			Object.hasOwn(body, "aggs"),
			false,
			`body must NOT contain aggs; got body=${JSON.stringify(body)}`,
		);
	});

	it("emits cardinality and missing aggs in request", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "locations",
					keyword: true,
					aggregations: ["cardinality"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Scalar", name: "string" } },
					} as unknown as Type,
				}),
				makeField({
					name: "description",
					optional: true,
					aggregations: ["missing"],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(
			combinedContent(result).includes(
				'{n:"uniqueLocationCount",a:{ cardinality: { field: "locations" } }}',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				'{n:"missingDescriptionCount",a:{ missing: { field: "description.keyword" } }}',
			),
		);
	});

	it("emits an auto_date_histogram floored at the declared interval when no bounds are given", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "validFrom",
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: [
						{ kind: "date_histogram", options: { interval: "month" } },
					],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		const content = combinedContent(result);
		// The `,h:1` marker lets buildAggs count the entry against the
		// per-request bucket budget (issue #155).
		assert.ok(
			content.includes(
				'{n:"byValidFromOverTime",a:ADH("validFrom", "month"),h:1}',
			),
		);
		// buildAggs sets `buckets` per request from the divided budget, so the
		// helper no longer bakes a fixed ceiling.
		assert.ok(
			content.includes(
				"const ADH = (f, m) => ({ auto_date_histogram: { field: f, minimum_interval: m } });",
			),
			"the bounds-less form must cap buckets rather than the range",
		);
		assert.ok(
			content.includes(
				`if (budget > ${DEFAULT_AUTO_DATE_HISTOGRAM_BUCKETS}) budget = ${DEFAULT_AUTO_DATE_HISTOGRAM_BUCKETS};`,
			),
			"the per-histogram ceiling is applied in buildAggs' budget division",
		);
		assert.ok(
			!content.includes("calendar_interval"),
			"an unbounded histogram must not pin a fixed interval over an unbounded range",
		);
		assert.ok(
			combinedContent(result).includes(
				"byValidFromOverTime: (_a.byValidFromOverTime?.buckets ?? []).map((b) => ({ key: `${b.key_as_string ?? b.key}`, keyAsString: b.key_as_string ?? null, count: b.doc_count }))",
			),
			"date_histogram response must use template-literal coercion (APPSYNC_JS forbids String()) and surface keyAsString",
		);
	});

	it("emits a real date_histogram at the declared interval when bounds are given", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "validFrom",
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: [
						{
							kind: "date_histogram",
							options: {
								interval: "month",
								bounds: { min: "2020-01-01T00:00:00Z", max: "now" },
							},
						},
					],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		const content = combinedContent(result);
		assert.ok(
			content.includes(
				'{n:"byValidFromOverTime",a:{ date_histogram: { field: "validFrom", calendar_interval: "month", hard_bounds: {"min":"2020-01-01T00:00:00Z","max":"now"} } }}',
			),
			"declared bounds pin the range, so the declared interval is safe to emit",
		);
		assert.ok(
			!content.includes("ADH"),
			"a bounded histogram needs no auto_date_histogram helper",
		);
	});

	it("keeps a week/quarter histogram at its declared interval (no minimum_interval spelling exists)", async () => {
		for (const interval of ["week", "quarter"] as const) {
			const projection = makeProjection({
				fields: [
					makeField({
						name: "validFrom",
						type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
						aggregations: [{ kind: "date_histogram", options: { interval } }],
					}),
				],
			});
			const result = await emitGraphQLResolver(projection, defaultOptions);
			const content = combinedContent(result);
			assert.ok(
				content.includes(
					`{n:"byValidFromOverTime",a:{ date_histogram: { field: "validFrom", calendar_interval: "${interval}" } }}`,
				),
				`${interval} must keep its declared interval rather than silently shift resolution`,
			);
			assert.ok(
				!content.includes("auto_date_histogram"),
				`auto_date_histogram cannot express a ${interval} floor`,
			);
		}
	});

	it("honours a configured auto-date-histogram bucket ceiling", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "validFrom",
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: [
						{ kind: "date_histogram", options: { interval: "day" } },
					],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, {
			...defaultOptions,
			autoDateHistogramBuckets: 512,
		});
		// The configured value is the per-histogram ceiling buildAggs applies
		// when dividing the per-request bucket budget (issue #155).
		assert.ok(
			combinedContent(result).includes("if (budget > 512) budget = 512;"),
		);
		const body = evalRequestBody(prepareFunctionContent(result), {
			selectionSetList: ["aggregations", "aggregations/byValidFromOverTime"],
		});
		const aggs = body.aggs as Record<
			string,
			{ auto_date_histogram: { buckets: number } }
		>;
		assert.equal(aggs.byValidFromOverTime.auto_date_histogram.buckets, 512);
	});

	// Issue #150 (2): an open-ended adoption carries a far-future sentinel
	// `validTo`. A monthly histogram over that range spans ~96,000 buckets and
	// OpenSearch rejects the whole search past search.max_buckets (65,535).
	it("emits a bounded-bucket query for sentinel-dated nested date fields (issue #150)", async () => {
		const projection = makeProjection({
			name: "PetSearchDoc",
			indexName: "pets",
			fields: [
				makeField({
					name: "adoptions",
					nested: true,
					filterables: ["exists"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
					subProjection: {
						projectionModel: { name: "AdoptionSearchDoc" },
						sourceModel: { name: "Adoption" },
						indexName: "adoptions",
						fields: [
							makeField({
								name: "status",
								keyword: true,
								filterables: ["term"],
								aggregations: ["terms"],
							}),
							makeField({
								name: "validTo",
								type: {
									kind: "Scalar",
									name: "utcDateTime",
								} as unknown as Type,
								aggregations: [
									{ kind: "date_histogram", options: { interval: "month" } },
								],
							}),
						],
					} as unknown as ResolvedProjection,
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		const content = combinedContent(result);
		assert.ok(
			content.includes('a:ADH("adoptions.validTo", "month")'),
			"the sentinel-prone field must cap its bucket count",
		);
		// The bucket ceiling is what makes the query survivable: OpenSearch
		// returns at most this many buckets whatever the range holds, so a
		// year-9999 sentinel yields coarser buckets instead of a rejected search.
		assert.ok(
			DEFAULT_AUTO_DATE_HISTOGRAM_BUCKETS < 65_535,
			"the ceiling must sit under OpenSearch's default search.max_buckets",
		);
		assert.ok(
			!content.includes("calendar_interval"),
			"no unbounded fixed-interval histogram may survive in the emitted query",
		);
	});

	it("emits range buckets with the configured ranges", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "notional",
					type: { kind: "Scalar", name: "float64" } as unknown as Type,
					aggregations: [
						{
							kind: "range",
							options: {
								ranges: [
									{ to: 1000 },
									{ from: 1000, to: 10000 },
									{ from: 10000 },
								],
							},
						},
					],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		assert.ok(
			combinedContent(result).includes(
				'{n:"byNotionalRange",a:{ range: { field: "notional", ranges: [{"to":1000},{"from":1000,"to":10000},{"from":10000}] } }}',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				"byNotionalRange: (_a.byNotionalRange?.buckets ?? []).map((b) => ({ key: b.key, from: b.from ?? null, to: b.to ?? null, count: b.doc_count }))",
			),
		);
	});

	it("emits terms with sub-aggregations", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "counterpartyId",
					keyword: true,
					aggregations: [
						{
							kind: "terms",
							options: {
								sub: { latestValidTo: { kind: "max", field: "validTo" } },
							},
						},
					],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		assert.ok(
			combinedContent(result).includes(
				'{n:"byCounterpartyId",a:{ terms: { field: "counterpartyId" }, aggs: { "latestValidTo": { max: { field: "validTo" } } } }}',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				", latestValidTo: b.latestValidTo?.value ?? null",
			),
		);
	});

	it("emits top_hits sub-agg under terms when topHits option is set", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "counterpartyId",
					keyword: true,
					aggregations: [{ kind: "terms", options: { topHits: 5 } }],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(
			combinedContent(result).includes(
				'{n:"byCounterpartyId",a:{ terms: { field: "counterpartyId" }, aggs: { "hits": { top_hits: { size: 5 } } } }}',
			),
			"terms agg request must include hits sub-agg with top_hits.size",
		);
		assert.ok(
			combinedContent(result).includes(
				", hits: (b.hits?.hits?.hits ?? []).map((h) => h._source)",
			),
			"terms response must unwrap hits.hits._source onto the bucket's hits field",
		);
	});

	it("emits combined sub-aggs and top_hits when both options are set", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "counterpartyId",
					keyword: true,
					aggregations: [
						{
							kind: "terms",
							options: {
								topHits: 3,
								sub: { latestValidTo: { kind: "max", field: "validTo" } },
							},
						},
					],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		assert.ok(
			combinedContent(result).includes(
				'aggs: { "latestValidTo": { max: { field: "validTo" } }, "hits": { top_hits: { size: 3 } } }',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				", latestValidTo: b.latestValidTo?.value ?? null, hits: (b.hits?.hits?.hits ?? []).map((h) => h._source)",
			),
		);
	});

	it("emits sum/avg/min/max numeric metric aggs", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "notional",
					type: { kind: "Scalar", name: "float64" } as unknown as Type,
					aggregations: ["sum", "avg"],
				}),
				makeField({
					name: "rank",
					type: { kind: "Scalar", name: "int32" } as unknown as Type,
					aggregations: ["min", "max"],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(
			combinedContent(result).includes(
				'{n:"notionalSum",a:{ sum: { field: "notional" } }}',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				'{n:"notionalAvg",a:{ avg: { field: "notional" } }}',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				'{n:"rankMin",a:{ min: { field: "rank" } }}',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				'{n:"rankMax",a:{ max: { field: "rank" } }}',
			),
		);

		assert.ok(
			combinedContent(result).includes(
				"notionalSum: _a.notionalSum?.value ?? null",
			),
		);
		assert.ok(
			combinedContent(result).includes("rankMax: _a.rankMax?.value ?? null"),
		);
	});

	it("wraps aggs inside @nested sub-projection in nested+inner block", async () => {
		const subProjection = {
			projectionModel: { name: "TagSearchDoc" },
			sourceModel: { name: "Tag" },
			indexName: "tags",
			fields: [
				makeField({
					name: "name",
					keyword: true,
					aggregations: ["terms", "cardinality"],
				}),
				makeField({
					name: "note",
					optional: true,
					aggregations: ["missing"],
				}),
			],
		} as unknown as ResolvedProjection;

		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					nested: true,
					subProjection,
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});

		const result = await emitGraphQLResolver(projection, defaultOptions);

		// Every agg under a nested path carries that path's group key, so the
		// selected ones share ONE `{ nested: ..., aggs: { ... } }` wrapper at
		// request time instead of one wrapper each (issue #105).
		for (const specEntry of [
			'{n:"byTagName",g:"_tags",p:"tags",a:{ terms: { field: "tags.name" } }}',
			'{n:"uniqueTagNameCount",g:"_tags",p:"tags",a:{ cardinality: { field: "tags.name" } }}',
			'{n:"missingTagNoteCount",g:"_tags",p:"tags",a:{ missing: { field: "tags.note.keyword" } }}',
		]) {
			assert.ok(
				combinedContent(result).includes(specEntry),
				`AGG_SPEC must include ${specEntry}`,
			);
		}

		assert.ok(
			combinedContent(result).includes(
				"byTagName: (_a_tags.byTagName?.buckets ?? []).map",
			),
		);
		assert.ok(
			combinedContent(result).includes(
				"uniqueTagNameCount: _a_tags.uniqueTagNameCount?.value ?? 0",
			),
		);
		assert.ok(
			combinedContent(result).includes(
				"missingTagNoteCount: _a_tags.missingTagNoteCount?.doc_count ?? 0",
			),
		);
	});

	it("does not wrap top-level aggregations in nested block", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					aggregations: ["terms"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Scalar", name: "string" } },
					} as unknown as Type,
				}),
			],
		});

		const result = await emitGraphQLResolver(projection, defaultOptions);
		assert.ok(
			combinedContent(result).includes(
				'{n:"byTag",a:{ terms: { field: "tags.keyword" } }}',
			),
		);
		// Aggs for non-@nested fields must not be wrapped in `{ nested: ... }`.
		assert.ok(!combinedContent(result).includes('{n:"byTag",a:{ nested:'));
	});

	it("emits aggregations mapping in response", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					keyword: true,
					aggregations: ["terms"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Scalar", name: "string" } },
					} as unknown as Type,
				}),
				makeField({
					name: "locations",
					keyword: true,
					aggregations: ["cardinality"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Scalar", name: "string" } },
					} as unknown as Type,
				}),
				makeField({
					name: "description",
					optional: true,
					aggregations: ["missing"],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(combinedContent(result).includes("aggregations: {"));
		assert.ok(
			combinedContent(result).includes("byTag: (_a.byTag?.buckets ?? []).map"),
		);
		assert.ok(
			combinedContent(result).includes(
				"uniqueLocationCount: _a.uniqueLocationCount?.value ?? 0",
			),
		);
		assert.ok(
			combinedContent(result).includes(
				"missingDescriptionCount: _a.missingDescriptionCount?.doc_count ?? 0",
			),
		);
	});
});

describe("emitGraphQLResolver search filter DSL", () => {
	function nestedTagSubProjection() {
		return {
			projectionModel: { name: "TagSearchDoc" },
			sourceModel: { name: "Tag" },
			indexName: "tags",
			fields: [
				makeField({
					name: "name",
					keyword: true,
					filterables: ["term", "term_negate"],
				}),
				makeField({
					name: "note",
					optional: true,
					filterables: ["exists"],
				}),
			],
		} as unknown as ResolvedProjection;
	}

	it("emits a static FILTER_SPEC literal for filterable fields", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term", "term_negate"],
				}),
				makeField({
					name: "rank",
					filterables: ["range"],
					type: { kind: "Scalar", name: "int32" } as unknown as Type,
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		assert.ok(combinedContent(result).includes("const FILTER_SPEC = ["));
		assert.ok(combinedContent(result).includes('"species"'));
		assert.ok(combinedContent(result).includes('"speciesNot"'));
		// Range now emits ONE FILTER_SPEC entry per field (#101); the
		// resolver expands "rankGte"/"Lte"/"Gt"/"Lt" lookups at runtime.
		assert.ok(
			combinedContent(result).includes('{i:"rank",k:"range",f:"rank"}'),
		);
		assert.ok(!combinedContent(result).includes('"rankGte"'));
	});

	it("emits an empty FILTER_SPEC when no @filterable fields", async () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		assert.ok(combinedContent(result).includes("const FILTER_SPEC = []"));
	});

	it("buildQuery returns match_all when no inputs", async () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);
		assert.deepEqual(buildQuery(undefined, undefined, undefined), {
			match_all: {},
		});
	});

	it("buildQuery emits flat term filter into bool.filter", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term"],
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);
		const result = buildQuery(undefined, undefined, { species: "cat" });
		assert.deepEqual(result, {
			bool: {
				filter: [{ term: { species: "cat" } }],
			},
		});
	});

	it("buildQuery emits terms (multi-value) filter as bool.filter[terms]", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["terms"],
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);
		const result = buildQuery(undefined, undefined, {
			speciesIn: ["cat", "dog"],
		});
		assert.deepEqual(result, {
			bool: {
				filter: [{ terms: { species: ["cat", "dog"] } }],
			},
		});
	});

	it("buildQuery skips terms filter when array is empty", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["terms"],
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);
		const result = buildQuery(undefined, undefined, { speciesIn: [] });
		assert.deepEqual(result, { match_all: {} });
	});

	it("buildQuery emits flat term_negate into bool.must_not", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term_negate"],
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);
		const result = buildQuery(undefined, undefined, { speciesNot: "cat" });
		assert.deepEqual(result, {
			bool: {
				must_not: [{ term: { species: "cat" } }],
			},
		});
	});

	it("buildQuery wraps nested term in nested+bool.filter under outer filter", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					nested: true,
					subProjection: nestedTagSubProjection(),
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);
		const result = buildQuery(undefined, undefined, {
			tags: { name: "vip" },
		});
		assert.deepEqual(result, {
			bool: {
				filter: [
					{
						nested: {
							path: "tags",
							query: {
								bool: { filter: [{ term: { "tags.name": "vip" } }] },
							},
						},
					},
				],
			},
		});
	});

	it("buildQuery wraps nested term_negate inside nested under outer must_not", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					nested: true,
					subProjection: nestedTagSubProjection(),
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);
		const result = buildQuery(undefined, undefined, {
			tags: { nameNot: "blocked" },
		});
		assert.deepEqual(result, {
			bool: {
				must_not: [
					{
						nested: {
							path: "tags",
							query: {
								bool: { filter: [{ term: { "tags.name": "blocked" } }] },
							},
						},
					},
				],
			},
		});
	});

	it("buildQuery groups range bounds into one range clause", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "createdAt",
					filterables: ["range"],
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);
		const result = buildQuery(undefined, undefined, {
			createdAtGte: "2026-01-01",
			createdAtLt: "2026-02-01",
		});
		assert.deepEqual(result, {
			bool: {
				filter: [
					{
						range: {
							createdAt: { gte: "2026-01-01", lt: "2026-02-01" },
						},
					},
				],
			},
		});
	});

	it("buildQuery emits exists in filter for true and must_not for false", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "nickname",
					optional: true,
					filterables: ["exists"],
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);

		assert.deepEqual(
			buildQuery(undefined, undefined, { nicknameExists: true }),
			{
				bool: {
					filter: [{ exists: { field: "nickname.keyword" } }],
				},
			},
		);
		assert.deepEqual(
			buildQuery(undefined, undefined, { nicknameExists: false }),
			{
				bool: {
					must_not: [{ exists: { field: "nickname.keyword" } }],
				},
			},
		);
	});

	it("buildQuery combines multi_match text search with searchFilter", async () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term"],
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);
		const result = buildQuery("fluffy", undefined, { species: "cat" }) as {
			bool: { must: unknown[]; filter: unknown[] };
		};
		assert.equal(result.bool.must.length, 1);
		assert.equal(result.bool.filter.length, 1);
		assert.deepEqual(result.bool.filter[0], {
			term: { species: "cat" },
		});
	});

	it("buildQuery still honors legacy keyword `filter` argument", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);
		const result = buildQuery(undefined, { species: "cat" }, undefined);
		assert.deepEqual(result, {
			bool: {
				filter: [{ term: { species: "cat" } }],
			},
		});
	});

	it("emitted resolver contains no forbidden global coercion calls (String, Number, Boolean, Array, Object)", async () => {
		// APPSYNC_JS rejects these globals at deploy time even though
		// @aws-appsync/eslint-plugin doesn't flag them (no rule covers
		// global function calls). Use template literals (\`${x}\`) for
		// string coercion and arithmetic / comparisons for the others.
		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({
					name: "validFrom",
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: [
						{ kind: "date_histogram", options: { interval: "month" } },
					],
				}),
				makeField({
					name: "notional",
					type: { kind: "Scalar", name: "float64" } as unknown as Type,
					aggregations: [
						{
							kind: "range",
							options: { ranges: [{ to: 1000 }, { from: 1000 }] },
						},
						"sum",
						"avg",
					],
				}),
				makeField({
					name: "counterpartyId",
					keyword: true,
					filterables: ["term", "terms"],
					aggregations: [
						{
							kind: "terms",
							options: {
								sub: { latestValidTo: { kind: "max", field: "validTo" } },
								topHits: 3,
							},
						},
					],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		const forbidden = ["String", "Number", "Boolean", "Array", "Object"];
		const allFiles = [
			{ name: "resolver", content: result.content },
			...result.functions.map((fn) => ({ name: fn.name, content: fn.content })),
		];
		for (const file of allFiles) {
			for (const name of forbidden) {
				const re = new RegExp(`\\b${name}\\s*\\(`);
				assert.equal(
					re.test(file.content),
					false,
					`emitted ${file.name} must not call \`${name}(...)\` — APPSYNC_JS rejects global coercion calls.\n--- emitted ---\n${file.content}\n--- end ---`,
				);
			}
		}
	});

	it("emitted resolver passes @aws-appsync/eslint-plugin recommended config", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term", "term_negate"],
					aggregations: ["terms", "cardinality", "missing"],
				}),
				makeField({
					name: "rank",
					filterables: ["range"],
					type: { kind: "Scalar", name: "int32" } as unknown as Type,
				}),
				makeField({
					name: "nickname",
					filterables: ["exists"],
				}),
				makeField({
					name: "notional",
					type: { kind: "Scalar", name: "float64" } as unknown as Type,
					aggregations: [
						"sum",
						"avg",
						"min",
						"max",
						{
							kind: "range",
							options: { ranges: [{ to: 1000 }, { from: 1000 }] },
						},
					],
				}),
				makeField({
					name: "validFrom",
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: [
						{ kind: "date_histogram", options: { interval: "month" } },
					],
				}),
				makeField({
					name: "counterpartyId",
					keyword: true,
					aggregations: [
						{
							kind: "terms",
							options: {
								sub: { latestValidTo: { kind: "max", field: "validTo" } },
							},
						},
					],
				}),
				makeField({
					name: "counterpartyId",
					keyword: true,
					searchable: false,
					filterables: ["term"],
				}),
				makeField({
					name: "tags",
					nested: true,
					subProjection: nestedTagSubProjection(),
					filterables: ["exists"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		const { ESLint } = await import("eslint");
		// @ts-expect-error — plugin ships no type declarations.
		const { default: appsyncPlugin } = await import(
			"@aws-appsync/eslint-plugin"
		);

		const dir = await mkdtemp(join(tmpdir(), "appsync-lint-"));
		try {
			const fileNames = ["resolver.js"];
			await writeFile(join(dir, "resolver.js"), result.content);
			for (const fn of result.functions) {
				const fileName = `${fn.name}.js`;
				fileNames.push(fileName);
				await writeFile(join(dir, fileName), fn.content);
			}
			// no-recursion is type-aware and needs a real TS project on disk.
			await writeFile(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						target: "ES2022",
						module: "ES2022",
						allowJs: true,
						checkJs: false,
						noEmit: true,
					},
					include: fileNames,
				}),
			);

			const eslint = new ESLint({
				cwd: dir,
				overrideConfigFile: true,
				overrideConfig: [
					{
						...appsyncPlugin.configs.recommended,
						languageOptions: {
							...appsyncPlugin.configs.recommended.languageOptions,
							sourceType: "module",
							ecmaVersion: 2022,
							parserOptions: {
								project: "./tsconfig.json",
								tsconfigRootDir: dir,
								ecmaVersion: 2022,
								sourceType: "module",
							},
						},
					},
				],
			});
			const lintResults = await eslint.lintFiles(
				fileNames.map((n) => join(dir, n)),
			);
			const messages = lintResults.flatMap((r) =>
				r.messages.map(
					(m) =>
						`[${m.ruleId ?? "fatal"}] ${r.filePath.split("/").pop()} line ${m.line ?? "?"}: ${m.message}`,
				),
			);
			assert.deepEqual(
				messages,
				[],
				`@aws-appsync/eslint-plugin reported issues:\n${messages.join("\n")}\n--- emitted resolver ---\n${result.content}\n--- prepare ---\n${result.functions.find((f) => f.name === "prepare")?.content}\n--- search ---\n${result.functions.find((f) => f.name === "search")?.content}`,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('emits nested_exists FILTER_SPEC entry for @filterable("exists") on a @nested array field', async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					nested: true,
					subProjection: nestedTagSubProjection(),
					filterables: ["exists"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		assert.ok(
			combinedContent(result).includes(
				'{i:"tagsExists",k:"nested_exists",p:"tags"}',
			),
			"FILTER_SPEC must carry a nested_exists entry with the path (compact-key form)",
		);
	});

	it("buildQuery translates tagsExists: true into nested+match_all in bool.filter", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					nested: true,
					subProjection: nestedTagSubProjection(),
					filterables: ["exists"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);

		const truthy = buildQuery(undefined, undefined, { tagsExists: true });
		assert.deepEqual(truthy, {
			bool: {
				filter: [{ nested: { path: "tags", query: { match_all: {} } } }],
			},
		});

		const falsy = buildQuery(undefined, undefined, { tagsExists: false });
		assert.deepEqual(falsy, {
			bool: {
				must_not: [{ nested: { path: "tags", query: { match_all: {} } } }],
			},
		});
	});

	it("buildQuery preserves nested-filter semantics for deeply structured input", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term"],
				}),
				makeField({
					name: "tags",
					nested: true,
					subProjection: nestedTagSubProjection(),
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);
		const result = buildQuery(undefined, undefined, {
			species: "cat",
			tags: { name: "vip", noteExists: true },
		}) as { bool: { filter: unknown[] } };

		assert.ok(
			result.bool.filter.some(
				(c) =>
					JSON.stringify(c) === JSON.stringify({ term: { species: "cat" } }),
			),
			"flat term clause missing",
		);
		assert.ok(
			result.bool.filter.some(
				(c) =>
					JSON.stringify(c) ===
					JSON.stringify({
						nested: {
							path: "tags",
							query: {
								bool: { filter: [{ term: { "tags.name": "vip" } }] },
							},
						},
					}),
			),
			"nested term clause missing",
		);
		assert.ok(
			result.bool.filter.some(
				(c) =>
					JSON.stringify(c) ===
					JSON.stringify({
						nested: {
							path: "tags",
							query: {
								bool: {
									filter: [{ exists: { field: "tags.note.keyword" } }],
								},
							},
						},
					}),
			),
			"nested exists clause missing",
		);
	});

	// Issue #110: a SearchFilter input that traverses two levels of nested
	// struct (e.g. `locations.address.country` on a counterparty projection,
	// where `locations` is @nested and `address` is a non-@nested struct
	// sub-projection) was silently dropped. The SDL accepted the input but
	// the prepare function emitted no clause, so OS returned the unfiltered
	// total instead of the filtered subset.
	it("buildQuery walks non-@nested struct (object kind) inside a @nested array — locations.address.country (issue #110)", async () => {
		const addressSubProjection = {
			projectionModel: { name: "AddressSearchDoc" },
			sourceModel: { name: "Address" },
			indexName: "addresses",
			fields: [
				makeField({
					name: "country",
					keyword: true,
					filterables: ["term"],
				}),
				makeField({
					name: "city",
					keyword: true,
					filterables: ["term"],
				}),
			],
		} as unknown as ResolvedProjection;

		const locationSubProjection = {
			projectionModel: { name: "LocationSearchDoc" },
			sourceModel: { name: "Location" },
			indexName: "locations",
			fields: [
				makeField({
					name: "type",
					keyword: true,
					filterables: ["term"],
				}),
				makeField({
					name: "address",
					subProjection: addressSubProjection,
				}),
			],
		} as unknown as ResolvedProjection;

		const projection = makeProjection({
			name: "CounterpartySearchDoc",
			fields: [
				makeField({
					name: "locations",
					nested: true,
					subProjection: locationSubProjection,
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});

		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);

		const result = buildQuery(undefined, undefined, {
			locations: { address: { country: "PT" } },
		});

		assert.deepEqual(result, {
			bool: {
				filter: [
					{
						nested: {
							path: "locations",
							query: {
								bool: {
									filter: [
										{
											term: { "locations.address.country": "PT" },
										},
									],
								},
							},
						},
					},
				],
			},
		});
	});

	// Issue #110: same hazard, two-level @nested. Outer finalize used to run
	// before inner finalize had populated its parent's child-clause array,
	// silently dropping the inner term.
	it("buildQuery walks @nested inside @nested — addresses.country wrapped in two nested clauses", async () => {
		const addressSubProjection = {
			projectionModel: { name: "AddressSearchDoc" },
			sourceModel: { name: "Address" },
			indexName: "addresses",
			fields: [
				makeField({
					name: "country",
					keyword: true,
					filterables: ["term"],
				}),
			],
		} as unknown as ResolvedProjection;

		const locationSubProjection = {
			projectionModel: { name: "LocationSearchDoc" },
			sourceModel: { name: "Location" },
			indexName: "locations",
			fields: [
				makeField({
					name: "addresses",
					nested: true,
					subProjection: addressSubProjection,
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		} as unknown as ResolvedProjection;

		const projection = makeProjection({
			fields: [
				makeField({
					name: "locations",
					nested: true,
					subProjection: locationSubProjection,
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});

		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);

		const result = buildQuery(undefined, undefined, {
			locations: { addresses: { country: "PT" } },
		});

		assert.deepEqual(result, {
			bool: {
				filter: [
					{
						nested: {
							path: "locations",
							query: {
								bool: {
									filter: [
										{
											nested: {
												path: "locations.addresses",
												query: {
													bool: {
														filter: [
															{
																term: {
																	"locations.addresses.country": "PT",
																},
															},
														],
													},
												},
											},
										},
									],
								},
							},
						},
					},
				],
			},
		});
	});

	// Issue #110: term_negate inside an object-in-nested descent must end up
	// on bool.must_not at the outer query level (mirrors the term path).
	it("buildQuery routes term_negate from inside object-in-nested to outer bool.must_not", async () => {
		const addressSubProjection = {
			projectionModel: { name: "AddressSearchDoc" },
			sourceModel: { name: "Address" },
			indexName: "addresses",
			fields: [
				makeField({
					name: "country",
					keyword: true,
					filterables: ["term_negate"],
				}),
			],
		} as unknown as ResolvedProjection;

		const locationSubProjection = {
			projectionModel: { name: "LocationSearchDoc" },
			sourceModel: { name: "Location" },
			indexName: "locations",
			fields: [
				makeField({
					name: "address",
					subProjection: addressSubProjection,
				}),
			],
		} as unknown as ResolvedProjection;

		const projection = makeProjection({
			fields: [
				makeField({
					name: "locations",
					nested: true,
					subProjection: locationSubProjection,
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});

		const buildQuery = loadBuildQuery(
			prepareFunctionContent(
				await emitGraphQLResolver(projection, defaultOptions),
			),
		);

		const result = buildQuery(undefined, undefined, {
			locations: { address: { countryNot: "PT" } },
		});

		assert.deepEqual(result, {
			bool: {
				must_not: [
					{
						nested: {
							path: "locations",
							query: {
								bool: {
									filter: [
										{
											term: { "locations.address.country": "PT" },
										},
									],
								},
							},
						},
					},
				],
			},
		});
	});
});

describe("emitGraphQLResolver datasource error propagation (issue #150)", () => {
	const okBody = {
		hits: {
			total: { value: 1 },
			hits: [{ _source: { name: "Rex" }, sort: [1] }],
		},
	};

	// The reported failure: OpenSearch rejects the search, and the emitted code
	// must name `too_many_buckets_exception` rather than let an undefined body
	// reach the after-mapping and resurface as a phantom ReferenceError.
	const osErrorBody = {
		error: {
			type: "too_many_buckets_exception",
			reason:
				"Trying to create too many buckets. Must be less than or equal to: [65535] but was [95947].",
		},
		status: 400,
	};

	async function emitPipeline(): Promise<EmitResult> {
		return await emitGraphQLResolver(
			makeProjection({ fields: [makeField({ name: "name" })] }),
			defaultOptions,
		);
	}

	it("search function surfaces ctx.error with its message and type", async () => {
		const result = await emitPipeline();
		const err = captureResponseError(searchFunctionContent(result), {
			error: { message: "Connection refused", type: "ServiceUnavailable" },
			result: undefined,
		});

		assert.equal(err.message, "Connection refused");
		assert.equal(err.errorType, "ServiceUnavailable");
	});

	it("search function surfaces an OpenSearch error envelope's type and reason", async () => {
		const result = await emitPipeline();
		const err = captureResponseError(searchFunctionContent(result), {
			result: osErrorBody,
		});

		assert.equal(err.errorType, "too_many_buckets_exception");
		assert.match(err.message, /too many buckets/);
		assert.match(err.message, /95947/);
	});

	it("search function carries the response body as errorInfo, not data", async () => {
		const result = await emitPipeline();
		const err = captureResponseError(searchFunctionContent(result), {
			result: osErrorBody,
		});

		assert.deepEqual(
			err.errorInfo,
			osErrorBody,
			"the body must travel as errorInfo; AppSync filters `data` against the query selection set, which an OpenSearch body shares no field with",
		);
		assert.equal(err.data, null);
	});

	it("search function carries ctx.result as errorInfo when ctx.error is set", async () => {
		const result = await emitPipeline();
		const err = captureResponseError(searchFunctionContent(result), {
			error: { message: "Connection refused", type: "ServiceUnavailable" },
			result: osErrorBody,
		});

		assert.deepEqual(err.errorInfo, osErrorBody);
		assert.equal(err.data, null);
	});

	it("search function surfaces a non-2xx datasource response", async () => {
		const result = await emitPipeline();
		const err = captureResponseError(searchFunctionContent(result), {
			result: { statusCode: 503, body: "service unavailable" },
		});

		assert.equal(err.errorType, "OpenSearchError");
		assert.match(err.message, /503/);
		assert.match(err.message, /service unavailable/);
	});

	it("search function surfaces a missing result rather than passing undefined on", async () => {
		const result = await emitPipeline();
		const err = captureResponseError(searchFunctionContent(result), {
			result: undefined,
		});

		assert.equal(err.errorType, "OpenSearchError");
		assert.match(err.message, /OpenSearch search failed/);
	});

	it("search function passes a successful response through unchanged", async () => {
		const result = await emitPipeline();
		const passed = evalResponse(searchFunctionContent(result), {
			result: okBody,
		});

		assert.deepEqual(passed, okBody);
	});

	it("after-mapping reports a missing body instead of a ReferenceError on parsedBody", async () => {
		const result = await emitPipeline();
		const err = captureResponseError(result.content, {
			args: {},
			prev: { result: undefined },
		});

		assert.equal(err.errorType, "OpenSearchError");
		assert.match(err.message, /OpenSearch search failed/);
		assert.doesNotMatch(
			err.message,
			/is not defined/,
			"the after-mapping must name the real failure, not a phantom ReferenceError",
		);
	});

	it("after-mapping surfaces an OpenSearch error envelope reaching ctx.prev.result", async () => {
		const result = await emitPipeline();
		const err = captureResponseError(result.content, {
			args: {},
			prev: { result: osErrorBody },
		});

		assert.equal(err.errorType, "too_many_buckets_exception");
		assert.match(err.message, /too many buckets/);
		assert.deepEqual(err.errorInfo, osErrorBody);
		assert.equal(err.data, null);
	});

	it("after-mapping shapes a successful response unchanged", async () => {
		const result = await emitPipeline();
		const shaped = evalResponse(result.content, {
			args: {},
			prev: { result: okBody },
		}) as { totalCount: number; edges: { node: unknown }[] };

		assert.equal(shaped.totalCount, 1);
		assert.deepEqual(shaped.edges[0].node, { name: "Rex" });
	});

	it("monolithic after-mapping guards a missing body too", async () => {
		const result = await emitGraphQLResolver(
			makeProjection({ fields: [makeField({ name: "name" })] }),
			{ ...defaultOptions, monolithicThresholdBytes: 28_000 },
		);
		assert.equal(result.mode, "monolithic");

		const err = captureResponseError(result.content, {
			args: {},
			result: osErrorBody,
		});
		assert.equal(err.errorType, "too_many_buckets_exception");

		const shaped = evalResponse(result.content, {
			args: {},
			result: okBody,
		}) as { totalCount: number };
		assert.equal(shaped.totalCount, 1);
	});
});

describe("emitGraphQLResolver histogram bucket budget (issue #155)", () => {
	// search.max_buckets (65,535) caps the whole request, not one aggregation.
	// A request selecting several histograms divides a per-request budget across
	// them rather than giving each its own ceiling, so their sum stays under the
	// cap however many are selected.
	function histogramProjection(count: number): ResolvedProjection {
		return makeProjection({
			fields: Array.from({ length: count }, (_, i) =>
				makeField({
					name: `h${i}`,
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: [
						{ kind: "date_histogram", options: { interval: "month" } },
					],
				}),
			),
		});
	}

	// Reads the auto_date_histogram agg names (marked `,h:1`) straight off the
	// emitted AGG_SPEC, so the tests don't depend on the field-name → agg-name
	// derivation.
	function histogramAggNames(source: string): string[] {
		const names: string[] = [];
		const re = /\{n:"([^"]+)"[^}]*,h:1\}/g;
		let match = re.exec(source);
		while (match) {
			names.push(match[1]);
			match = re.exec(source);
		}
		return names;
	}

	function bucketsOf(body: Record<string, unknown>, name: string): number {
		const aggs = body.aggs as Record<
			string,
			{ auto_date_histogram?: { buckets?: number } }
		>;
		const buckets = aggs[name]?.auto_date_histogram?.buckets;
		assert.equal(
			typeof buckets,
			"number",
			`expected numeric buckets on ${name}; got aggs=${JSON.stringify(aggs)}`,
		);
		return buckets as number;
	}

	function expectedBudget(
		selected: number,
		cap = DEFAULT_AUTO_DATE_HISTOGRAM_BUCKETS,
	): number {
		let budget = Math.floor(PER_REQUEST_BUCKET_BUDGET / selected);
		if (budget > cap) budget = cap;
		if (budget < MIN_AUTO_DATE_HISTOGRAM_BUCKETS)
			budget = MIN_AUTO_DATE_HISTOGRAM_BUCKETS;
		return budget;
	}

	function aggSelection(names: string[]): { selectionSetList: string[] } {
		return {
			selectionSetList: [
				"aggregations",
				...names.map((n) => `aggregations/${n}`),
			],
		};
	}

	it("divides the per-request budget across the histograms actually selected", async () => {
		const result = await emitGraphQLResolver(
			histogramProjection(5),
			defaultOptions,
		);
		const source = prepareFunctionContent(result);
		const names = histogramAggNames(source);
		assert.equal(names.length, 5);

		const body = evalRequestBody(source, aggSelection(names));
		const expected = expectedBudget(5); // floor(21845 / 5) = 4369
		for (const name of names) {
			assert.equal(bucketsOf(body, name), expected);
		}
	});

	it("budgets against the selected count, not every declared histogram", async () => {
		const result = await emitGraphQLResolver(
			histogramProjection(5),
			defaultOptions,
		);
		const source = prepareFunctionContent(result);
		const selected = histogramAggNames(source).slice(0, 3);

		const body = evalRequestBody(source, aggSelection(selected));
		assert.deepEqual(
			Object.keys(body.aggs as Record<string, unknown>).sort(),
			[...selected].sort(),
		);
		const expected = expectedBudget(3); // floor(21845 / 3) = 7281
		for (const name of selected) {
			assert.equal(bucketsOf(body, name), expected);
		}
	});

	it("gives a single selected histogram the full per-histogram ceiling", async () => {
		const result = await emitGraphQLResolver(
			histogramProjection(1),
			defaultOptions,
		);
		const source = prepareFunctionContent(result);
		const [name] = histogramAggNames(source);

		const body = evalRequestBody(source, aggSelection([name]));
		// floor(21845 / 1) exceeds the ceiling, so the ceiling wins.
		assert.equal(bucketsOf(body, name), DEFAULT_AUTO_DATE_HISTOGRAM_BUCKETS);
	});

	it("floors the per-histogram budget so a wide selection stays legible", async () => {
		const result = await emitGraphQLResolver(
			histogramProjection(100),
			defaultOptions,
		);
		const source = prepareFunctionContent(result);
		const names = histogramAggNames(source);
		assert.equal(names.length, 100);

		const body = evalRequestBody(source, aggSelection(names));
		// floor(21845 / 100) = 218 < the floor, so every histogram clamps to it.
		for (const name of names) {
			assert.equal(bucketsOf(body, name), MIN_AUTO_DATE_HISTOGRAM_BUCKETS);
		}
	});

	it("counts the alias fallback's histograms against the same budget", async () => {
		// An aliased aggregation names no AGG_SPEC entry, so the fallback sends
		// every aggregation. Those histograms must divide the budget too, or the
		// fallback reintroduces the per-request blowout.
		const result = await emitGraphQLResolver(
			histogramProjection(5),
			defaultOptions,
		);
		const source = prepareFunctionContent(result);
		const names = histogramAggNames(source);

		const body = evalRequestBody(source, {
			selectionSetList: [
				"aggregations",
				"aggregations/whateverAlias",
				"aggregations/whateverAlias/key",
			],
		});
		assert.deepEqual(
			Object.keys(body.aggs as Record<string, unknown>).sort(),
			[...names].sort(),
		);
		const expected = expectedBudget(names.length); // 5 -> 4369
		for (const name of names) {
			assert.equal(bucketsOf(body, name), expected);
		}
	});

	it("leaves an author-bounded histogram out of the budget (bounds opt-out)", async () => {
		// Declared bounds pin the range, so the histogram is the author's
		// explicit choice: it keeps its fixed interval and hard_bounds, carries
		// no bucket cap, and does not consume the auto-histogram budget.
		const projection = makeProjection({
			fields: [
				makeField({
					name: "bounded",
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: [
						{
							kind: "date_histogram",
							options: {
								interval: "month",
								bounds: { min: "now-5y", max: "now" },
							},
						},
					],
				}),
				...Array.from({ length: 4 }, (_, i) =>
					makeField({
						name: `auto${i}`,
						type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
						aggregations: [
							{ kind: "date_histogram", options: { interval: "month" } },
						],
					}),
				),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);
		const source = prepareFunctionContent(result);
		const autoNames = histogramAggNames(source);
		assert.equal(
			autoNames.length,
			4,
			"only the bounds-less histograms carry the h:1 budget marker",
		);

		const body = evalRequestBody(source, {
			selectionSetList: [
				"aggregations",
				"aggregations/byBoundedOverTime",
				...autoNames.map((n) => `aggregations/${n}`),
			],
		});
		const aggs = body.aggs as Record<
			string,
			{
				date_histogram?: { hard_bounds?: unknown };
				auto_date_histogram?: { buckets?: number };
			}
		>;
		assert.ok(
			aggs.byBoundedOverTime.date_histogram?.hard_bounds,
			"a bounded histogram keeps its declared hard_bounds",
		);
		assert.equal(
			aggs.byBoundedOverTime.auto_date_histogram,
			undefined,
			"a bounded histogram is not emitted as an auto_date_histogram",
		);
		// Only the 4 auto histograms divide the budget; the bounded one does not.
		const expected = expectedBudget(4); // floor(21845 / 4) = 5461
		for (const name of autoNames) {
			assert.equal(bucketsOf(body, name), expected);
		}
	});
});

describe("emitGraphQLResolver wide-projection budget (issue #105)", () => {
	function makeWideSubProjection(
		name: string,
		extraFields: Array<ResolvedProjection["fields"][0]> = [],
	): ResolvedProjection {
		return {
			projectionModel: { name: `${name}SearchDoc` },
			sourceModel: { name },
			indexName: name.toLowerCase(),
			fields: [
				makeField({
					name: `${lowerFirst(name)}Id`,
					keyword: true,
					filterables: ["term", "terms", "exists"],
					aggregations: ["terms"],
				}),
				makeField({
					name: "type",
					keyword: true,
					filterables: ["term", "terms", "exists"],
					aggregations: ["terms"],
				}),
				makeField({
					name: "createdAt",
					filterables: ["range"],
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: [
						"sum",
						"avg",
						"min",
						"max",
						{ kind: "date_histogram", options: { interval: "month" } },
					],
				}),
				makeField({
					name: "updatedAt",
					filterables: ["range"],
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: ["sum", "avg", "min", "max"],
				}),
				...extraFields,
			],
		} as unknown as ResolvedProjection;
	}

	function lowerFirst(s: string): string {
		return s[0].toLowerCase() + s.slice(1);
	}

	it("counterparty-shape projection (7 nested sub-models) emits resolver under 32 KB AppSync cap", async () => {
		// Synthetic mirror of the consumer counterparty projection: 7 @nested
		// sub-models (approvals/relations/locations/contacts/tags/groups/references),
		// each with id+type+createdAt+updatedAt aggs/filters. Acceptance criterion
		// from issue #105: counterparty-search-doc-resolver.js was 37,310 bytes
		// post-#101 — needs to fit under AppSync's 32,768-byte resolver code cap.
		const subShapes = [
			"Approval",
			"Relation",
			"Location",
			"Contact",
			"Tag",
			"Group",
			"Reference",
		];
		const projection = makeProjection({
			name: "CounterpartySearchDoc",
			indexName: "counterparties_v1",
			fields: [
				makeField({
					name: "counterpartyId",
					keyword: true,
					filterables: ["term", "terms", "exists"],
					aggregations: ["terms"],
				}),
				makeField({
					name: "createdAt",
					filterables: ["range"],
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: ["sum", "avg", "min", "max"],
				}),
				makeField({
					name: "updatedAt",
					filterables: ["range"],
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: ["sum", "avg", "min", "max"],
				}),
				...subShapes.map((shape) =>
					makeField({
						name: `${shape.toLowerCase()}s`,
						nested: true,
						subProjection: makeWideSubProjection(shape),
						filterables: ["exists"],
						type: {
							kind: "Model",
							name: "Array",
							indexer: { value: { kind: "Model" } },
						} as unknown as Type,
					}),
				),
			],
		});

		const result = await emitGraphQLResolver(projection, defaultOptions);

		// Pipeline resolver: cap is per-file (resolver after-mapping + each
		// pipeline function), not the sum. Issue #105 acceptance: each emitted
		// file under AppSync's 32,768-byte cap, with headroom for future growth.
		const files = [
			{ name: "resolver", content: result.content },
			...result.functions.map((fn) => ({ name: fn.name, content: fn.content })),
		];
		for (const file of files) {
			const bytes = Buffer.byteLength(file.content, "utf8");
			assert.ok(
				bytes < 32_768,
				`wide projection ${file.name} file is ${bytes} bytes; must stay under AppSync's 32,768-byte per-file cap (issue #105). Headroom: ${32_768 - bytes} bytes.`,
			);
		}
	});

	it("counterparty-shape projection with searchable text in every nested sub-model stays under the cap", async () => {
		// The nested free-text clause (issue #158) is the one part of buildQuery
		// that scales with sub-model count, so it gets its own width guard: the
		// counterparty shape with two @searchable text fields per sub-model —
		// the shape that reported the bug (a nested "find by reference" lookup).
		const subShapes = [
			"Approval",
			"Relation",
			"Location",
			"Contact",
			"Tag",
			"Group",
			"Reference",
		];
		const projection = makeProjection({
			name: "CounterpartySearchDoc",
			indexName: "counterparties_v1",
			fields: subShapes.map((shape) =>
				makeField({
					name: `${shape.toLowerCase()}s`,
					nested: true,
					subProjection: makeWideSubProjection(shape, [
						makeField({ name: "name" }),
						makeField({ name: "value" }),
					]),
					filterables: ["exists"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			),
		});

		const result = await emitGraphQLResolver(projection, defaultOptions);
		const files = [
			{ name: "resolver", content: result.content },
			...result.functions.map((fn) => ({ name: fn.name, content: fn.content })),
		];

		// Every sub-model contributes a group to the NESTED_TEXT_GROUPS data
		// array (issue #168) rather than its own NQ(...) call site, so the
		// per-group cost is the data tuple only — a runtime loop builds the
		// clauses, and the generated code stays flat regardless of group count.
		const prepare = files.find((f) => f.name === "prepare");
		assert.ok(prepare);
		for (const shape of subShapes) {
			assert.ok(
				prepare.content.includes(
					`["${shape.toLowerCase()}s",["${shape.toLowerCase()}s.name","${shape.toLowerCase()}s.value"]]`,
				),
				`missing nested text group for ${shape}`,
			);
		}
		assert.ok(
			prepare.content.includes("for (const group of NESTED_TEXT_GROUPS)"),
			"nested text clauses must be built by a runtime loop over NESTED_TEXT_GROUPS, not unrolled per group",
		);

		for (const file of files) {
			const bytes = Buffer.byteLength(file.content, "utf8");
			assert.ok(
				bytes < 32_768,
				`${file.name} is ${bytes} bytes; must stay under AppSync's 32,768-byte per-file cap. Headroom: ${32_768 - bytes} bytes.`,
			);
		}
	});
});

// Issue #112 — two-stage adaptive emit: threshold-based monolithic vs
// pipeline mode. (Terser-based minify pass was removed; consumers either fit
// monolithic verbose or fall back to the pipeline split.)
describe("emitGraphQLResolver two-stage emit (issue #112)", () => {
	const monolithicOptions = {
		defaultPageSize: 20,
		maxPageSize: 100,
		trackTotalHitsUpTo: 10000,
		monolithicThresholdBytes: 32000,
	};

	it("emits monolithic UNIT shape for a typical projection (mode 'monolithic', no functions)", async () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term", "term_negate"],
					aggregations: ["terms"],
				}),
				makeField({
					name: "createdAt",
					filterables: ["range"],
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: [
						{ kind: "date_histogram", options: { interval: "month" } },
					],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, monolithicOptions);

		assert.equal(result.mode, "monolithic");
		assert.equal(result.functions.length, 0);
		// Monolithic resolver carries the OS HTTP request shape directly —
		// no pipeline before/after, no `ctx.prev.result`, no `ctx.stash`.
		assert.ok(
			result.content.includes('operation:"GET"') ||
				result.content.includes('operation: "GET"'),
		);
		assert.ok(!result.content.includes("ctx.prev.result"));
		assert.ok(!result.content.includes("ctx.stash"));
	});

	it("falls back to pipeline when monolithic exceeds threshold", async () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term"],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, {
			...monolithicOptions,
			monolithicThresholdBytes: 0,
		});

		assert.equal(result.mode, "pipeline");
		assert.equal(result.functions.length, 2);
		assert.deepEqual(
			result.functions.map((f) => f.name),
			["prepare", "search"],
		);
	});

	it("counterparty-shape projection fits under threshold in monolithic mode (perf-critical case)", async () => {
		// Mirrors the wide-projection acceptance test — 7 nested sub-models
		// with id+type+createdAt+updatedAt aggs/filters. Issue #112 expects
		// this shape to fit monolithic (under 32K), unlocking the ~50ms
		// median latency saving.
		const subShapes = [
			"Approval",
			"Relation",
			"Location",
			"Contact",
			"Tag",
			"Group",
			"Reference",
		];
		function lowerFirst(s: string): string {
			return s[0].toLowerCase() + s.slice(1);
		}
		const projection = makeProjection({
			name: "CounterpartySearchDoc",
			indexName: "counterparties_v1",
			fields: [
				makeField({
					name: "counterpartyId",
					keyword: true,
					filterables: ["term", "terms", "exists"],
					aggregations: ["terms"],
				}),
				makeField({
					name: "createdAt",
					filterables: ["range"],
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: ["sum", "avg", "min", "max"],
				}),
				...subShapes.map((shape) =>
					makeField({
						name: `${shape.toLowerCase()}s`,
						nested: true,
						subProjection: {
							projectionModel: { name: `${shape}SearchDoc` },
							sourceModel: { name: shape },
							indexName: shape.toLowerCase(),
							fields: [
								makeField({
									name: `${lowerFirst(shape)}Id`,
									keyword: true,
									filterables: ["term", "terms", "exists"],
									aggregations: ["terms"],
								}),
								makeField({
									name: "type",
									keyword: true,
									filterables: ["term", "terms", "exists"],
									aggregations: ["terms"],
								}),
								makeField({
									name: "createdAt",
									filterables: ["range"],
									type: {
										kind: "Scalar",
										name: "utcDateTime",
									} as unknown as Type,
								}),
							],
						} as unknown as ResolvedProjection,
						filterables: ["exists"],
						type: {
							kind: "Model",
							name: "Array",
							indexer: { value: { kind: "Model" } },
						} as unknown as Type,
					}),
				),
			],
		});

		const result = await emitGraphQLResolver(projection, monolithicOptions);
		const bytes = Buffer.byteLength(result.content, "utf-8");

		assert.equal(
			result.mode,
			"monolithic",
			`Counterparty projection should fit monolithic; got ${bytes} bytes`,
		);
		assert.ok(bytes < 28_000, "monolithic must fit under threshold");
	});

	it("pipelines a synthetic wide projection (14 sub-models)", async () => {
		function lowerFirst(s: string): string {
			return s[0].toLowerCase() + s.slice(1);
		}
		const subShapes = Array.from({ length: 14 }, (_, i) => `Sub${i}`);
		const projection = makeProjection({
			name: "WideSearchDoc",
			indexName: "wide_v1",
			fields: subShapes.map((shape) =>
				makeField({
					name: `${shape.toLowerCase()}s`,
					nested: true,
					subProjection: {
						projectionModel: { name: `${shape}SearchDoc` },
						sourceModel: { name: shape },
						indexName: shape.toLowerCase(),
						fields: [
							makeField({
								name: `${lowerFirst(shape)}Id`,
								keyword: true,
								filterables: ["term", "terms", "exists"],
								aggregations: ["terms"],
							}),
							makeField({
								name: "type",
								keyword: true,
								filterables: ["term", "terms", "exists"],
								aggregations: ["terms"],
							}),
							makeField({
								name: "createdAt",
								filterables: ["range"],
								type: {
									kind: "Scalar",
									name: "utcDateTime",
								} as unknown as Type,
								aggregations: [
									"sum",
									"avg",
									"min",
									"max",
									{ kind: "date_histogram", options: { interval: "month" } },
								],
							}),
							makeField({
								name: "updatedAt",
								filterables: ["range"],
								type: {
									kind: "Scalar",
									name: "utcDateTime",
								} as unknown as Type,
								aggregations: ["sum", "avg", "min", "max"],
							}),
						],
					} as unknown as ResolvedProjection,
					filterables: ["exists"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			),
		});

		const result = await emitGraphQLResolver(projection, monolithicOptions);

		assert.equal(result.mode, "pipeline");
		const files = [
			{ name: "resolver", content: result.content },
			...result.functions.map((fn) => ({
				name: fn.name,
				content: fn.content,
			})),
		];
		for (const file of files) {
			const bytes = Buffer.byteLength(file.content, "utf-8");
			assert.ok(
				bytes < 32_768,
				`wide projection pipeline file ${file.name} is ${bytes} bytes; must stay under 32 KB cap`,
			);
		}
	});

	it("monolithic output passes @aws-appsync/eslint-plugin recommended config", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term", "term_negate"],
					aggregations: ["terms", "cardinality", "missing"],
				}),
				makeField({
					name: "rank",
					filterables: ["range"],
					type: { kind: "Scalar", name: "int32" } as unknown as Type,
				}),
				makeField({
					name: "validFrom",
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: [
						{ kind: "date_histogram", options: { interval: "month" } },
					],
				}),
				makeField({
					name: "counterpartyId",
					keyword: true,
					aggregations: [
						{
							kind: "terms",
							options: {
								sub: { latestValidTo: { kind: "max", field: "validTo" } },
							},
						},
					],
				}),
			],
		});
		const result = await emitGraphQLResolver(projection, monolithicOptions);
		assert.equal(result.mode, "monolithic");

		const { ESLint } = await import("eslint");
		// @ts-expect-error — plugin ships no type declarations.
		const { default: appsyncPlugin } = await import(
			"@aws-appsync/eslint-plugin"
		);

		const dir = await mkdtemp(join(tmpdir(), "appsync-lint-mono-"));
		try {
			await writeFile(join(dir, "resolver.js"), result.content);
			await writeFile(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						target: "ES2022",
						module: "ES2022",
						allowJs: true,
						checkJs: false,
						noEmit: true,
					},
					include: ["resolver.js"],
				}),
			);
			const eslint = new ESLint({
				cwd: dir,
				overrideConfigFile: true,
				overrideConfig: [
					{
						...appsyncPlugin.configs.recommended,
						languageOptions: {
							...appsyncPlugin.configs.recommended.languageOptions,
							sourceType: "module",
							ecmaVersion: 2022,
							parserOptions: {
								project: "./tsconfig.json",
								tsconfigRootDir: dir,
								ecmaVersion: 2022,
								sourceType: "module",
							},
						},
					},
				],
			});
			const lintResults = await eslint.lintFiles([join(dir, "resolver.js")]);
			const messages = lintResults.flatMap((r) =>
				r.messages.map(
					(m) =>
						`[${m.ruleId ?? "fatal"}] ${r.filePath.split("/").pop()} line ${m.line ?? "?"}: ${m.message}`,
				),
			);
			assert.deepEqual(
				messages,
				[],
				`@aws-appsync/eslint-plugin reported issues on monolithic output:\n${messages.join("\n")}\n--- emitted ---\n${result.content}`,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
