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
 * Loads the buildQuery function from a generated resolver source string.
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

const defaultOptions = {
	defaultPageSize: 20,
	maxPageSize: 100,
	trackTotalHitsUpTo: 10000,
};

describe("emitGraphQLResolver", () => {
	it("generates resolver file with correct name", () => {
		const projection = makeProjection({ fields: [] });
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.equal(result.fileName, "pet-search-doc-resolver.js");
		assert.equal(result.queryFieldName, "searchPet");
	});

	it("includes index name in request path", () => {
		const projection = makeProjection({
			indexName: "pets_v1",
			fields: [],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes("/pets_v1/_search"));
	});

	it("includes text fields in multi_match", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" }), makeField({ name: "breed" })],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('"name","breed"'));
	});

	it("includes keyword fields in filter logic", () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "species", keyword: true }),
				makeField({ name: "status", keyword: true }),
			],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('"species","status"'));
	});

	it("excludes nested and sub-projection fields from text fields", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('["name"]'));
	});

	it("excludes non-searchable filter-only fields from text_fields and keyword_fields but includes them in FILTER_SPEC", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(
			result.content.includes('fields: ["name"]'),
			"counterpartyId is not @searchable so must not appear in multi_match fields",
		);
		assert.ok(
			result.content.includes(
				'{i:"counterpartyId",k:"term",f:"counterpartyId"}',
			),
			"FILTER_SPEC must carry the term filter for the non-searchable field (compact-key form)",
		);
	});

	it("excludes non-searchable agg-only fields from text/keyword sets but includes them in aggs", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('fields: ["name"]'));
		assert.ok(
			result.content.includes("byType:"),
			"aggregation should still be emitted for non-searchable agg-only field",
		);
	});

	it("respects custom page size and track_total_hits options", () => {
		const projection = makeProjection({ fields: [] });
		const result = emitGraphQLResolver(projection, {
			defaultPageSize: 10,
			maxPageSize: 50,
			trackTotalHitsUpTo: 5000,
		});

		assert.ok(result.content.includes("args.first || 10"));
		assert.ok(result.content.includes("50)"));
		assert.ok(result.content.includes("track_total_hits: 5000"));
	});

	it("uses projectedName for field references", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name", projectedName: "displayName" })],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('"displayName"'));
		assert.ok(!result.content.includes('"name"'));
	});

	it("has no import statements except aws-appsync/utils", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		const imports = result.content
			.split("\n")
			.filter((l) => l.startsWith("import "));
		assert.equal(imports.length, 1);
		assert.ok(imports[0].includes("@aws-appsync/utils"));
	});

	it("falls back to _score desc then _id asc when sortBy arg is omitted", () => {
		const projection = makeProjection({ fields: [] });
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('{ _score: "desc" }'));
		assert.ok(result.content.includes('{ _id: "asc" }'));
		// New: resolver routes sort through buildSort(args.sortBy) so callers
		// can override the fallback.
		assert.ok(result.content.includes("buildSort(args.sortBy)"));
		assert.ok(result.content.includes("function buildSort(sortBy)"));
	});

	it("buildSort honors sortBy arg with multiple fields, appending _id tie-break", () => {
		const projection = makeProjection({ fields: [] });
		const source = emitGraphQLResolver(projection, defaultOptions).content;
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

	it("uses search_after for cursor pagination", () => {
		const projection = makeProjection({ fields: [] });
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes("search_after"));
		assert.ok(result.content.includes("base64Decode"));
		assert.ok(result.content.includes("base64Encode"));
	});

	it("omits aggs block when no aggregations", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(!result.content.includes("aggs:"));
		assert.ok(!result.content.includes("aggregations:"));
	});

	it("emits aggs block in request when fields have aggregations", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes("aggs:"));
		assert.ok(
			result.content.includes('byTag: { terms: { field: "tags.keyword" } }'),
		);
		assert.ok(
			result.content.includes('bySpecy: { terms: { field: "species" } }'),
		);
	});

	it("emits cardinality and missing aggs in request", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(
			result.content.includes(
				'uniqueLocationCount: { cardinality: { field: "locations" } }',
			),
		);
		assert.ok(
			result.content.includes(
				'missingDescriptionCount: { missing: { field: "description.keyword" } }',
			),
		);
	});

	it("emits date_histogram with calendar_interval option", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);
		assert.ok(
			result.content.includes(
				'byValidFromOverTime: { date_histogram: { field: "validFrom", calendar_interval: "month" } }',
			),
		);
		assert.ok(
			result.content.includes(
				"byValidFromOverTime: (parsedBody.aggregations?.byValidFromOverTime?.buckets ?? []).map((b) => ({ key: `${b.key_as_string ?? b.key}`, keyAsString: b.key_as_string ?? null, count: b.doc_count }))",
			),
			"date_histogram response must use template-literal coercion (APPSYNC_JS forbids String()) and surface keyAsString",
		);
	});

	it("emits range buckets with the configured ranges", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);
		assert.ok(
			result.content.includes(
				'byNotionalRange: { range: { field: "notional", ranges: [{"to":1000},{"from":1000,"to":10000},{"from":10000}] } }',
			),
		);
		assert.ok(
			result.content.includes(
				"byNotionalRange: (parsedBody.aggregations?.byNotionalRange?.buckets ?? []).map((b) => ({ key: b.key, from: b.from ?? null, to: b.to ?? null, count: b.doc_count }))",
			),
		);
	});

	it("emits terms with sub-aggregations", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);
		assert.ok(
			result.content.includes(
				'byCounterpartyId: { terms: { field: "counterpartyId" }, aggs: { "latestValidTo": { max: { field: "validTo" } } } }',
			),
		);
		assert.ok(
			result.content.includes(
				", latestValidTo: b.latestValidTo?.value ?? null",
			),
		);
	});

	it("emits top_hits sub-agg under terms when topHits option is set", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "counterpartyId",
					keyword: true,
					aggregations: [{ kind: "terms", options: { topHits: 5 } }],
				}),
			],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(
			result.content.includes(
				'byCounterpartyId: { terms: { field: "counterpartyId" }, aggs: { "hits": { top_hits: { size: 5 } } } }',
			),
			"terms agg request must include hits sub-agg with top_hits.size",
		);
		assert.ok(
			result.content.includes(
				", hits: (b.hits?.hits?.hits ?? []).map((h) => h._source)",
			),
			"terms response must unwrap hits.hits._source onto the bucket's hits field",
		);
	});

	it("emits combined sub-aggs and top_hits when both options are set", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);
		assert.ok(
			result.content.includes(
				'aggs: { "latestValidTo": { max: { field: "validTo" } }, "hits": { top_hits: { size: 3 } } }',
			),
		);
		assert.ok(
			result.content.includes(
				", latestValidTo: b.latestValidTo?.value ?? null, hits: (b.hits?.hits?.hits ?? []).map((h) => h._source)",
			),
		);
	});

	it("emits sum/avg/min/max numeric metric aggs", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(
			result.content.includes('notionalSum: { sum: { field: "notional" } }'),
		);
		assert.ok(
			result.content.includes('notionalAvg: { avg: { field: "notional" } }'),
		);
		assert.ok(result.content.includes('rankMin: { min: { field: "rank" } }'));
		assert.ok(result.content.includes('rankMax: { max: { field: "rank" } }'));

		assert.ok(
			result.content.includes(
				"notionalSum: parsedBody.aggregations?.notionalSum?.value ?? null",
			),
		);
		assert.ok(
			result.content.includes(
				"rankMax: parsedBody.aggregations?.rankMax?.value ?? null",
			),
		);
	});

	it("wraps aggs inside @nested sub-projection in nested+inner block", () => {
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

		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(
			result.content.includes(
				'byTagName: { nested: { path: "tags" }, aggs: { inner: { terms: { field: "tags.name" } } } }',
			),
		);
		assert.ok(
			result.content.includes(
				'uniqueTagNameCount: { nested: { path: "tags" }, aggs: { inner: { cardinality: { field: "tags.name" } } } }',
			),
		);
		assert.ok(
			result.content.includes(
				'missingTagNoteCount: { nested: { path: "tags" }, aggs: { inner: { missing: { field: "tags.note.keyword" } } } }',
			),
		);

		assert.ok(
			result.content.includes(
				"byTagName: (parsedBody.aggregations?.byTagName?.inner?.buckets ?? []).map",
			),
		);
		assert.ok(
			result.content.includes(
				"uniqueTagNameCount: parsedBody.aggregations?.uniqueTagNameCount?.inner?.value ?? 0",
			),
		);
		assert.ok(
			result.content.includes(
				"missingTagNoteCount: parsedBody.aggregations?.missingTagNoteCount?.inner?.doc_count ?? 0",
			),
		);
	});

	it("does not wrap top-level aggregations in nested block", () => {
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

		const result = emitGraphQLResolver(projection, defaultOptions);
		assert.ok(
			result.content.includes('byTag: { terms: { field: "tags.keyword" } }'),
		);
		// Aggs for non-@nested fields must not be wrapped in `{ nested: ... }`.
		assert.ok(!result.content.includes("byTag: { nested:"));
	});

	it("emits aggregations mapping in response", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes("aggregations: {"));
		assert.ok(
			result.content.includes(
				"byTag: (parsedBody.aggregations?.byTag?.buckets ?? []).map",
			),
		);
		assert.ok(
			result.content.includes(
				"uniqueLocationCount: parsedBody.aggregations?.uniqueLocationCount?.value ?? 0",
			),
		);
		assert.ok(
			result.content.includes(
				"missingDescriptionCount: parsedBody.aggregations?.missingDescriptionCount?.doc_count ?? 0",
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

	it("emits a static FILTER_SPEC literal for filterable fields", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);
		assert.ok(result.content.includes("const FILTER_SPEC = ["));
		assert.ok(result.content.includes('"species"'));
		assert.ok(result.content.includes('"speciesNot"'));
		assert.ok(result.content.includes('"rankGte"'));
		assert.ok(result.content.includes('"rankLte"'));
	});

	it("emits an empty FILTER_SPEC when no @filterable fields", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);
		assert.ok(result.content.includes("const FILTER_SPEC = []"));
	});

	it("buildQuery returns match_all when no inputs", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		const buildQuery = loadBuildQuery(
			emitGraphQLResolver(projection, defaultOptions).content,
		);
		assert.deepEqual(buildQuery(undefined, undefined, undefined), {
			match_all: {},
		});
	});

	it("buildQuery emits flat term filter into bool.filter", () => {
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
			emitGraphQLResolver(projection, defaultOptions).content,
		);
		const result = buildQuery(undefined, undefined, { species: "cat" });
		assert.deepEqual(result, {
			bool: {
				filter: [{ term: { species: "cat" } }],
			},
		});
	});

	it("buildQuery emits terms (multi-value) filter as bool.filter[terms]", () => {
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
			emitGraphQLResolver(projection, defaultOptions).content,
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

	it("buildQuery skips terms filter when array is empty", () => {
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
			emitGraphQLResolver(projection, defaultOptions).content,
		);
		const result = buildQuery(undefined, undefined, { speciesIn: [] });
		assert.deepEqual(result, { match_all: {} });
	});

	it("buildQuery emits flat term_negate into bool.must_not", () => {
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
			emitGraphQLResolver(projection, defaultOptions).content,
		);
		const result = buildQuery(undefined, undefined, { speciesNot: "cat" });
		assert.deepEqual(result, {
			bool: {
				must_not: [{ term: { species: "cat" } }],
			},
		});
	});

	it("buildQuery wraps nested term in nested+bool.filter under outer filter", () => {
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
			emitGraphQLResolver(projection, defaultOptions).content,
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

	it("buildQuery wraps nested term_negate inside nested under outer must_not", () => {
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
			emitGraphQLResolver(projection, defaultOptions).content,
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

	it("buildQuery groups range bounds into one range clause", () => {
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
			emitGraphQLResolver(projection, defaultOptions).content,
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

	it("buildQuery emits exists in filter for true and must_not for false", () => {
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
			emitGraphQLResolver(projection, defaultOptions).content,
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

	it("buildQuery combines multi_match text search with searchFilter", () => {
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
			emitGraphQLResolver(projection, defaultOptions).content,
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

	it("buildQuery still honors legacy keyword `filter` argument", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
				}),
			],
		});
		const buildQuery = loadBuildQuery(
			emitGraphQLResolver(projection, defaultOptions).content,
		);
		const result = buildQuery(undefined, { species: "cat" }, undefined);
		assert.deepEqual(result, {
			bool: {
				filter: [{ term: { species: "cat" } }],
			},
		});
	});

	it("emitted resolver contains no forbidden global coercion calls (String, Number, Boolean, Array, Object)", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		const forbidden = ["String", "Number", "Boolean", "Array", "Object"];
		for (const name of forbidden) {
			const re = new RegExp(`\\b${name}\\s*\\(`);
			assert.equal(
				re.test(result.content),
				false,
				`emitted resolver must not call \`${name}(...)\` — APPSYNC_JS rejects global coercion calls.\n--- emitted ---\n${result.content}\n--- end ---`,
			);
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		const { ESLint } = await import("eslint");
		// @ts-expect-error — plugin ships no type declarations.
		const { default: appsyncPlugin } = await import(
			"@aws-appsync/eslint-plugin"
		);

		const dir = await mkdtemp(join(tmpdir(), "appsync-lint-"));
		try {
			const filePath = join(dir, "resolver.js");
			await writeFile(filePath, result.content);
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
			const lintResults = await eslint.lintFiles([filePath]);
			const messages = lintResults.flatMap((r) =>
				r.messages.map(
					(m) => `[${m.ruleId ?? "fatal"}] line ${m.line ?? "?"}: ${m.message}`,
				),
			);
			assert.deepEqual(
				messages,
				[],
				`@aws-appsync/eslint-plugin reported issues:\n${messages.join("\n")}\n--- emitted resolver ---\n${result.content}`,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('emits nested_exists FILTER_SPEC entry for @filterable("exists") on a @nested array field', () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);
		assert.ok(
			result.content.includes('{i:"tagsExists",k:"nested_exists",p:"tags"}'),
			"FILTER_SPEC must carry a nested_exists entry with the path (compact-key form)",
		);
	});

	it("buildQuery translates tagsExists: true into nested+match_all in bool.filter", () => {
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
			emitGraphQLResolver(projection, defaultOptions).content,
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

	it("buildQuery preserves nested-filter semantics for deeply structured input", () => {
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
			emitGraphQLResolver(projection, defaultOptions).content,
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
});
