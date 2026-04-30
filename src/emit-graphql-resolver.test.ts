import assert from "node:assert/strict";
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
		type: Type;
		aggregations: ResolvedProjection["fields"][0]["aggregations"];
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
		searchable: true,
		type:
			overrides.type ??
			({
				kind: "Scalar",
				name: "string",
			} as unknown as Type),
		aggregations: overrides.aggregations,
		filterables: overrides.filterables,
		subProjection: overrides.subProjection,
	} as unknown as ResolvedProjection["fields"][0];
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

	it("sorts by _score desc then _id asc", () => {
		const projection = makeProjection({ fields: [] });
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('{ _score: "desc" }'));
		assert.ok(result.content.includes('{ _id: "asc" }'));
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
		assert.ok(!result.content.includes("nested: { path:"));
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

	it("applyFilterSpec body contains no self-recursive call (APPSYNC_JS forbids recursion)", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		const declStart = result.content.indexOf("function applyFilterSpec");
		assert.ok(
			declStart >= 0,
			"expected to find applyFilterSpec function in emitted resolver",
		);
		const bodyStart = result.content.indexOf("{", declStart);
		assert.ok(bodyStart > declStart, "function body opening brace not found");

		let depth = 0;
		let bodyEnd = -1;
		for (let i = bodyStart; i < result.content.length; i++) {
			const ch = result.content[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					bodyEnd = i + 1;
					break;
				}
			}
		}
		assert.ok(bodyEnd > bodyStart, "function body closing brace not found");
		const body = result.content.slice(bodyStart, bodyEnd);

		assert.equal(
			/\bapplyFilterSpec\s*\(/.test(body),
			false,
			`applyFilterSpec body must not call itself; APPSYNC_JS rejects recursive resolver code. Body was:\n${body}`,
		);
	});

	it("applyFilterSpec body contains no while or continue (APPSYNC_JS forbids both)", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		const declStart = result.content.indexOf("function applyFilterSpec");
		assert.ok(
			declStart >= 0,
			"expected to find applyFilterSpec function in emitted resolver",
		);
		const bodyStart = result.content.indexOf("{", declStart);
		assert.ok(bodyStart > declStart, "function body opening brace not found");

		let depth = 0;
		let bodyEnd = -1;
		for (let i = bodyStart; i < result.content.length; i++) {
			const ch = result.content[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					bodyEnd = i + 1;
					break;
				}
			}
		}
		assert.ok(bodyEnd > bodyStart, "function body closing brace not found");
		const body = result.content.slice(bodyStart, bodyEnd);

		assert.equal(
			/\bwhile\s*\(/.test(body),
			false,
			`applyFilterSpec body must not contain a while statement; APPSYNC_JS lint rule @aws-appsync/no-while rejects it. Body was:\n${body}`,
		);
		assert.equal(
			/\bcontinue\s*;/.test(body),
			false,
			`applyFilterSpec body must not contain a continue statement; APPSYNC_JS lint rule @aws-appsync/no-continue rejects it. Body was:\n${body}`,
		);
	});

	it("applyFilterSpec body contains no C-style for or ++/-- (APPSYNC_JS forbids both)", () => {
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
		const result = emitGraphQLResolver(projection, defaultOptions);

		const declStart = result.content.indexOf("function applyFilterSpec");
		assert.ok(
			declStart >= 0,
			"expected to find applyFilterSpec function in emitted resolver",
		);
		const bodyStart = result.content.indexOf("{", declStart);
		assert.ok(bodyStart > declStart, "function body opening brace not found");

		let depth = 0;
		let bodyEnd = -1;
		for (let i = bodyStart; i < result.content.length; i++) {
			const ch = result.content[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					bodyEnd = i + 1;
					break;
				}
			}
		}
		assert.ok(bodyEnd > bodyStart, "function body closing brace not found");
		const body = result.content.slice(bodyStart, bodyEnd);

		assert.equal(
			/\bfor\s*\(\s*(?:let|var|const)\b[^)]*;/.test(body),
			false,
			`applyFilterSpec body must not contain a C-style for(init;cond;update) statement; APPSYNC_JS lint rule @aws-appsync/no-for rejects it. Body was:\n${body}`,
		);
		assert.equal(
			/\+\+|--/.test(body),
			false,
			`applyFilterSpec body must not contain ++ or -- operators; APPSYNC_JS lint rule @aws-appsync/no-disallowed-unary-operators rejects them. Body was:\n${body}`,
		);
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
