import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Type } from "@typespec/compiler";
import { emitGraphQLResolver } from "./emit-graphql-resolver.js";
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

function makeField(
	overrides: Partial<{
		name: string;
		projectedName: string;
		keyword: boolean;
		nested: boolean;
		optional: boolean;
		searchable: boolean;
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

	it("excludes nested and sub-projection fields from text fields", async () => {
		const subProjection = {
			projectionModel: { name: "TagSearchDoc" },
		} as unknown as ResolvedProjection;

		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({ name: "tags", nested: true }),
				makeField({ name: "owner", subProjection }),
			],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(combinedContent(result).includes('["name"]'));
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

	it("uses search_after for cursor pagination", async () => {
		const projection = makeProjection({ fields: [] });
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(combinedContent(result).includes("search_after"));
		assert.ok(combinedContent(result).includes("base64Decode"));
		assert.ok(combinedContent(result).includes("base64Encode"));
	});

	it("omits aggs block when no aggregations", async () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		const result = await emitGraphQLResolver(projection, defaultOptions);

		assert.ok(!combinedContent(result).includes("aggs:"));
		assert.ok(!combinedContent(result).includes("body.aggs"));
		assert.ok(!combinedContent(result).includes("wantsAggs"));
		assert.ok(!combinedContent(result).includes("aggregations:"));
	});

	it("emits aggs block in request when fields have aggregations", async () => {
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

		assert.ok(combinedContent(result).includes("body.aggs = {"));
		assert.ok(
			combinedContent(result).includes(
				'byTag: { terms: { field: "tags.keyword" } }',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				'bySpecy: { terms: { field: "species" } }',
			),
		);
	});

	it("gates body.aggs assignment on ctx.info.selectionSetList containing aggregations", async () => {
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

		// The wantsAggs gate must check both the bare `aggregations` selection
		// and any nested `aggregations/...` sub-path. APPSYNC_JS forbids regex
		// and try/catch — keep the check to plain string comparisons.
		assert.ok(
			combined.includes(
				'ctx.info.selectionSetList.some((p) => p === "aggregations" || p.indexOf("aggregations/") === 0)',
			),
			`wantsAggs gate must read ctx.info.selectionSetList; got:\n${combined}`,
		);
		assert.ok(
			combined.includes("if (wantsAggs) {"),
			"body.aggs assignment must be inside `if (wantsAggs)` block",
		);
		// Sanity: the gate appears BEFORE `body.aggs = ` in the request function.
		const gateIdx = combined.indexOf("if (wantsAggs)");
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
				"aggregations/bySpecy",
				"aggregations/bySpecy/key",
			],
		});
		assert.ok(
			body.aggs && typeof body.aggs === "object",
			`body.aggs must be present when caller selects aggregations; got body=${JSON.stringify(body)}`,
		);
		const aggs = body.aggs as Record<string, unknown>;
		assert.ok(
			"bySpecy" in aggs,
			`body.aggs.bySpecy must be present; got aggs=${JSON.stringify(aggs)}`,
		);
	});

	it("emits cardinality and missing aggs in request", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "locations",
					keyword: true,
					aggregations: ["cardinality"],
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
				'uniqueLocationCount: { cardinality: { field: "locations" } }',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				'missingDescriptionCount: { missing: { field: "description.keyword" } }',
			),
		);
	});

	it("emits date_histogram with calendar_interval option", async () => {
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
		assert.ok(
			combinedContent(result).includes(
				'byValidFromOverTime: { date_histogram: { field: "validFrom", calendar_interval: "month" } }',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				"byValidFromOverTime: (_a.byValidFromOverTime?.buckets ?? []).map((b) => ({ key: `${b.key_as_string ?? b.key}`, keyAsString: b.key_as_string ?? null, count: b.doc_count }))",
			),
			"date_histogram response must use template-literal coercion (APPSYNC_JS forbids String()) and surface keyAsString",
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
				'byNotionalRange: { range: { field: "notional", ranges: [{"to":1000},{"from":1000,"to":10000},{"from":10000}] } }',
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
				'byCounterpartyId: { terms: { field: "counterpartyId" }, aggs: { "latestValidTo": { max: { field: "validTo" } } } }',
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
				'byCounterpartyId: { terms: { field: "counterpartyId" }, aggs: { "hits": { top_hits: { size: 5 } } } }',
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
				'notionalSum: { sum: { field: "notional" } }',
			),
		);
		assert.ok(
			combinedContent(result).includes(
				'notionalAvg: { avg: { field: "notional" } }',
			),
		);
		assert.ok(
			combinedContent(result).includes('rankMin: { min: { field: "rank" } }'),
		);
		assert.ok(
			combinedContent(result).includes('rankMax: { max: { field: "rank" } }'),
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

		// All nested aggs sharing a path are grouped under one wrapper
		// (`__n_<path>` key) — saves the per-agg `{ nested: ..., aggs: { inner: ... } }`
		// skeleton on wide projections (issue #105).
		assert.ok(
			combinedContent(result).includes(
				'_tags: { nested: { path: "tags" }, aggs: { byTagName: { terms: { field: "tags.name" } }, uniqueTagNameCount: { cardinality: { field: "tags.name" } }, missingTagNoteCount: { missing: { field: "tags.note.keyword" } } } }',
			),
		);

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
				'byTag: { terms: { field: "tags.keyword" } }',
			),
		);
		// Aggs for non-@nested fields must not be wrapped in `{ nested: ... }`.
		assert.ok(!combinedContent(result).includes("byTag: { nested:"));
	});

	it("emits aggregations mapping in response", async () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					keyword: true,
					aggregations: ["terms"],
				}),
				makeField({
					name: "locations",
					keyword: true,
					aggregations: ["cardinality"],
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
