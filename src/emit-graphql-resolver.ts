import { type AggregationEntry, collectAggregations } from "./aggregations.js";
import { toGraphQLQueryFieldName } from "./emit-graphql-sdl.js";
import {
	buildSearchFilterShape,
	type FilterSpecNode,
	type SearchFilterShape,
} from "./filters.js";
import { internStrings } from "./intern.js";
import type {
	ResolvedProjection,
	ResolvedProjectionField,
} from "./projection.js";
import { toKebabCase } from "./utils.js";

export type PipelineFunctionDataSource = "OPENSEARCH" | "NONE";

export interface EmittedPipelineFunction {
	name: string;
	fileName: string;
	content: string;
	dataSource: PipelineFunctionDataSource;
}

export type ResolverEmissionMode = "monolithic" | "pipeline";

export interface EmittedResolverFile {
	queryFieldName: string;
	/**
	 * `monolithic` — `content` carries the full UNIT resolver (request +
	 * response inline; reads OS via `operation: "GET"` directly). `functions`
	 * is empty.
	 * `pipeline` — `content` is the resolver-level after-mapping; `functions`
	 * holds the prepare (NONE) and search (OPENSEARCH) pipeline functions.
	 */
	mode: ResolverEmissionMode;
	/** Resolver-level file. UNIT body for monolithic; before/after for pipeline. */
	fileName: string;
	content: string;
	/**
	 * Pipeline functions in execution order. Consumers wire these as AppSync
	 * Functions and reference them on a PIPELINE Resolver. Splitting the work
	 * across functions keeps each file's APPSYNC_JS code under the 32 KB
	 * per-function cap, which a single-resolver shape would exceed on wide
	 * @searchInfer projections (issue #105). Empty for `mode === "monolithic"`.
	 */
	functions: EmittedPipelineFunction[];
}

export interface ResolverOptions {
	defaultPageSize: number;
	maxPageSize: number;
	trackTotalHitsUpTo: number;
	/**
	 * Apply post-emit string-literal interning (issue #114). Hoists every
	 * double-quoted string appearing >=2 times in a file into `const _s = [...]`
	 * and replaces each occurrence with `_s[N]`. APPSYNC_JS-safe by
	 * construction. Default: true. Replaces the terser-based minify pass —
	 * terser's general-JS optimizations passed static lint AND the
	 * `EvaluateCode` API but failed live AppSync on `term`/`range` clauses
	 * inside a `nested` path; custom interning emits only `const` array
	 * declarations and indexed reads, neither of which touches that surface.
	 */
	internStrings?: boolean;
	/**
	 * Byte threshold above which a projection's monolithic shape is rejected
	 * and the pipeline shape is emitted instead. Suggested 28,000 (32K cap
	 * minus headroom). Measured against the post-intern monolithic content.
	 */
	monolithicThresholdBytes?: number;
}

const DEFAULT_INTERN_STRINGS = true;
const DEFAULT_MONOLITHIC_THRESHOLD_BYTES = 32_000;

// Bound for the runtime applyFilterSpec walker's fixed-size work slot pool.
// APPSYNC_JS does not honor self-extending Array iteration, so the emitted
// function pre-allocates this many slots as a literal. Set well above any
// realistic SearchFilter shape; runtime util.error fires if exceeded.
const FILTER_WORK_SLOT_COUNT = 256;

export async function emitGraphQLResolver(
	projection: ResolvedProjection,
	options: ResolverOptions,
): Promise<EmittedResolverFile> {
	const typeName = projection.projectionModel.name;
	const queryFieldName = toGraphQLQueryFieldName(typeName);
	const baseName = toKebabCase(typeName);

	const textFields = projection.fields
		.filter(
			(f) =>
				f.searchable &&
				!f.keyword &&
				!f.nested &&
				!f.subProjection &&
				hasTextType(f),
		)
		.map((f) => f.projectedName ?? f.name);

	const keywordFields = projection.fields
		.filter((f) => f.searchable && f.keyword)
		.map((f) => f.projectedName ?? f.name);

	const aggregations = collectAggregations(projection);
	const searchFilterShape = buildSearchFilterShape(projection);

	const internEnabled = options.internStrings ?? DEFAULT_INTERN_STRINGS;
	const threshold =
		options.monolithicThresholdBytes ?? DEFAULT_MONOLITHIC_THRESHOLD_BYTES;
	const shrink = (src: string): string =>
		internEnabled ? internStrings(src) : src;

	// Stage 1 of the two-stage emit (issue #112): render the monolithic UNIT
	// shape first, optionally apply string-interning (issue #114), then
	// measure. Under the threshold we ship monolithic — saves ~50ms median
	// per query (pipeline-dispatch I/O). Over the threshold we fall back to
	// the pipeline split (issue #105).
	const monolithicRaw = renderMonolithicResolver(
		textFields,
		keywordFields,
		aggregations,
		searchFilterShape,
		projection.indexName,
		options,
	);
	const monolithicContent = shrink(monolithicRaw);
	const monolithicBytes = Buffer.byteLength(monolithicContent, "utf-8");

	if (monolithicBytes <= threshold) {
		return {
			queryFieldName,
			mode: "monolithic",
			fileName: `${baseName}-resolver.js`,
			content: monolithicContent,
			functions: [],
		};
	}

	// Pipeline fallback. Each function gets the same Stage 1 treatment so
	// per-function size stays tight against the per-file 32 KB cap (issue
	// #105). The resolver-level file holds the after-mapping; prepare runs
	// on NONE, search on OPENSEARCH.
	const prepareRaw = renderPrepareFunction(
		textFields,
		keywordFields,
		aggregations,
		searchFilterShape,
		options,
	);
	const searchRaw = renderSearchFunction(projection.indexName);
	const resolverRaw = renderResolver(aggregations, options);

	const prepareContent = shrink(prepareRaw);
	const searchContent = shrink(searchRaw);
	const resolverContent = shrink(resolverRaw);

	return {
		queryFieldName,
		mode: "pipeline",
		fileName: `${baseName}-resolver.js`,
		content: resolverContent,
		functions: [
			{
				name: "prepare",
				fileName: `${baseName}-fn-prepare.js`,
				content: prepareContent,
				dataSource: "NONE",
			},
			{
				name: "search",
				fileName: `${baseName}-fn-search.js`,
				content: searchContent,
				dataSource: "OPENSEARCH",
			},
		],
	};
}

function hasTextType(field: ResolvedProjectionField): boolean {
	const type = field.type;
	if (type.kind === "Scalar") {
		let current = type;
		while (current) {
			if (current.name === "string") return true;
			if (!current.baseScalar) break;
			current = current.baseScalar;
		}
	}
	return type.kind === "String";
}

/**
 * Monolithic UNIT resolver — single file with request building + OS dispatch +
 * response shaping inline. AppSync invokes `request(ctx)` once on the OS
 * datasource; the OS response lands in `ctx.result` (not `ctx.prev.result`,
 * which is pipeline-only). Issue #112 — collapses the 3-function pipeline
 * into one when the projection fits under threshold.
 */
function renderMonolithicResolver(
	textFields: string[],
	keywordFields: string[],
	aggregations: AggregationEntry[],
	searchFilterShape: SearchFilterShape | undefined,
	indexName: string,
	options: ResolverOptions,
): string {
	const textFieldsLiteral = JSON.stringify(textFields);
	const keywordFieldsLiteral = JSON.stringify(keywordFields);
	const aggsBlock = renderAggsBlock(aggregations);
	const filterSpecLiteral = renderFilterSpecLiteral(searchFilterShape);
	const slotsLiteral = `[${"null,".repeat(FILTER_WORK_SLOT_COUNT).slice(0, -1)}]`;
	const responseAggregationsPreamble =
		renderResponseAggregationsPreamble(aggregations);
	const responseAggregations = renderResponseAggregations(aggregations);

	return `import { util } from "@aws-appsync/utils";

const FILTER_SPEC = ${filterSpecLiteral};

export function request(ctx) {
	const args = ctx.args;
	const size = Math.min(args.first || ${options.defaultPageSize}, ${options.maxPageSize});
	const searchAfter = args.after ? JSON.parse(util.base64Decode(args.after)) : undefined;

	const query = buildQuery(args.query, args.filter, args.searchFilter);
	const sort = buildSort(args.sortBy);

	const body = {
		size: size + 1,
		track_total_hits: ${options.trackTotalHitsUpTo},
		sort,
		query,${aggsBlock}
	};

	if (searchAfter) {
		body.search_after = searchAfter;
	}

	return {
		operation: "GET",
		path: "/${indexName}/_search",
		params: { body },
	};
}

export function response(ctx) {
	if (ctx.error) {
		return util.error(ctx.error.message, ctx.error.type);
	}

	const parsedBody = ctx.result;
	const hits = parsedBody.hits.hits;
	const totalHits = parsedBody.hits.total.value;
	const args = ctx.args;
	const size = Math.min(args.first || ${options.defaultPageSize}, ${options.maxPageSize});

	const hasNextPage = hits.length > size;
	const edges = hits.slice(0, size).map((hit) => ({
		node: hit._source,
		cursor: util.base64Encode(JSON.stringify(hit.sort)),
	}));
${responseAggregationsPreamble}
	return {
		edges,
		totalCount: totalHits,${responseAggregations}
		pageInfo: {
			hasNextPage,
			endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
		},
	};
}

function buildQuery(queryText, filter, searchFilter) {
	const musts = [];
	const filters = [];
	const mustNots = [];

	if (queryText) {
		musts.push({
			multi_match: {
				query: queryText,
				fields: ${textFieldsLiteral},
				type: "best_fields",
			},
		});
	}

	const keywordFields = ${keywordFieldsLiteral};
	if (filter) {
		for (const field of keywordFields) {
			if (filter[field] != null) {
				filters.push({ term: { [field]: filter[field] } });
			}
		}
	}

	if (searchFilter) {
		applyFilterSpec(FILTER_SPEC, searchFilter, filters, mustNots);
	}

	if (musts.length === 0 && filters.length === 0 && mustNots.length === 0) {
		return { match_all: {} };
	}

	return {
		bool: {
			...(musts.length > 0 ? { must: musts } : {}),
			...(filters.length > 0 ? { filter: filters } : {}),
			...(mustNots.length > 0 ? { must_not: mustNots } : {}),
		},
	};
}

function buildSort(sortBy) {
	const fallback = [{ _score: "desc" }, { _id: "asc" }];
	if (!sortBy || sortBy.length === 0) {
		return fallback;
	}
	const out = [];
	for (const entry of sortBy) {
		if (entry && entry.field) {
			const direction = entry.direction === "ASC" ? "asc" : "desc";
			out.push({ [entry.field]: direction });
		}
	}
	out.push({ _id: "asc" });
	return out;
}

function applyFilterSpec(rootSpec, rootInput, rootOutFilters, rootOutMustNots) {
	if (!rootSpec || !rootInput) return;

	const procSlots = ${slotsLiteral};
	const finSlots = ${slotsLiteral};
	procSlots[0] = {
		spec: rootSpec,
		input: rootInput,
		outFilters: rootOutFilters,
		outMustNots: rootOutMustNots,
	};
	let procHead = 0;
	let procTail = 1;
	let finTail = 0;

	for (const _slot of procSlots) {
		if (procHead < procTail) {
			const item = procSlots[procHead];
			procHead = procHead + 1;
			const spec = item.spec;
			const input = item.input;
			const outFilters = item.outFilters;
			const outMustNots = item.outMustNots;

			for (const node of spec) {
				const value = input[node.i];
				if (node.k === "nested") {
					if (value != null) {
						const childFilters = [];
						const childMustNots = [];
						if (procTail + 1 > procSlots.length) {
							util.error(
								"applyFilterSpec exceeded fixed work-slot capacity; SearchFilter shape too deep for APPSYNC_JS function",
							);
						}
						if (finTail + 1 > finSlots.length) {
							util.error(
								"applyFilterSpec exceeded fixed finalize-slot capacity; SearchFilter shape too deep for APPSYNC_JS function",
							);
						}
						procSlots[procTail] = {
							spec: node.c,
							input: value,
							outFilters: childFilters,
							outMustNots: childMustNots,
						};
						procTail = procTail + 1;
						finSlots[finTail] = {
							path: node.p,
							childFilters,
							childMustNots,
							parentFilters: outFilters,
							parentMustNots: outMustNots,
						};
						finTail = finTail + 1;
					}
				} else if (node.k === "object") {
					if (value != null) {
						if (procTail + 1 > procSlots.length) {
							util.error(
								"applyFilterSpec exceeded fixed work-slot capacity; SearchFilter shape too deep for APPSYNC_JS function",
							);
						}
						procSlots[procTail] = {
							spec: node.c,
							input: value,
							outFilters,
							outMustNots,
						};
						procTail = procTail + 1;
					}
				} else if (node.k === "term") {
					if (value != null) {
						outFilters.push({ term: { [node.f]: value } });
					}
				} else if (node.k === "term_negate") {
					if (value != null) {
						outMustNots.push({ term: { [node.f]: value } });
					}
				} else if (node.k === "terms") {
					if (value != null && value.length > 0) {
						outFilters.push({ terms: { [node.f]: value } });
					}
				} else if (node.k === "exists") {
					if (value != null) {
						if (value === true) {
							outFilters.push({ exists: { field: node.f } });
						} else {
							outMustNots.push({ exists: { field: node.f } });
						}
					}
				} else if (node.k === "nested_exists") {
					if (value != null) {
						const nestedClause = {
							nested: { path: node.p, query: { match_all: {} } },
						};
						if (value === true) {
							outFilters.push(nestedClause);
						} else {
							outMustNots.push(nestedClause);
						}
					}
				} else if (node.k === "range") {
					const base = node.i;
					const bounds = {};
					let any = false;
					if (input[base + "Gte"] != null) {
						bounds.gte = input[base + "Gte"];
						any = true;
					}
					if (input[base + "Lte"] != null) {
						bounds.lte = input[base + "Lte"];
						any = true;
					}
					if (input[base + "Gt"] != null) {
						bounds.gt = input[base + "Gt"];
						any = true;
					}
					if (input[base + "Lt"] != null) {
						bounds.lt = input[base + "Lt"];
						any = true;
					}
					if (any) {
						outFilters.push({ range: { [node.f]: bounds } });
					}
				}
			}
		}
	}

	for (const _slot of finSlots) {
		if (finTail > 0) {
			finTail = finTail - 1;
			const item = finSlots[finTail];
			for (const clause of item.childFilters) {
				item.parentFilters.push({
					nested: {
						path: item.path,
						query: { bool: { filter: [clause] } },
					},
				});
			}
			for (const clause of item.childMustNots) {
				item.parentMustNots.push({
					nested: {
						path: item.path,
						query: { bool: { filter: [clause] } },
					},
				});
			}
		}
	}
}
`;
}

/**
 * Pipeline resolver "before/after" code. The `request` exports here become the
 * pipeline's before-mapping; `response` is the after-mapping that runs after
 * all functions complete. The OS response lives at `ctx.prev.result` after
 * the OS-datasource function in the pipeline returns.
 */
function renderResolver(
	aggregations: AggregationEntry[],
	options: ResolverOptions,
): string {
	const responseAggregationsPreamble =
		renderResponseAggregationsPreamble(aggregations);
	const responseAggregations = renderResponseAggregations(aggregations);

	return `import { util } from "@aws-appsync/utils";

export function request(ctx) {
	return {};
}

export function response(ctx) {
	if (ctx.error) {
		return util.error(ctx.error.message, ctx.error.type);
	}

	const parsedBody = ctx.prev.result;
	const hits = parsedBody.hits.hits;
	const totalHits = parsedBody.hits.total.value;
	const args = ctx.args;
	const size = Math.min(args.first || ${options.defaultPageSize}, ${options.maxPageSize});

	const hasNextPage = hits.length > size;
	const edges = hits.slice(0, size).map((hit) => ({
		node: hit._source,
		cursor: util.base64Encode(JSON.stringify(hit.sort)),
	}));
${responseAggregationsPreamble}
	return {
		edges,
		totalCount: totalHits,${responseAggregations}
		pageInfo: {
			hasNextPage,
			endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
		},
	};
}
`;
}

/**
 * Pipeline function on a NONE datasource. Builds the OS query body from
 * `ctx.args` (FILTER_SPEC walk + aggs assembly) and stashes it for the next
 * function to send. Holds the bulk of the request-side code: keeping it in
 * its own function keeps the resolver-level after-mapping (response shape +
 * aggregation mapping) under the 32 KB per-file APPSYNC_JS cap (issue #105).
 */
function renderPrepareFunction(
	textFields: string[],
	keywordFields: string[],
	aggregations: AggregationEntry[],
	searchFilterShape: SearchFilterShape | undefined,
	options: ResolverOptions,
): string {
	const textFieldsLiteral = JSON.stringify(textFields);
	const keywordFieldsLiteral = JSON.stringify(keywordFields);
	const aggsBlock = renderAggsBlock(aggregations);
	const filterSpecLiteral = renderFilterSpecLiteral(searchFilterShape);
	// `null` (4 chars) instead of `undefined` (9 chars) keeps the literal small
	// — saves ~5 bytes per slot. The walker never reads these init values; it
	// gates work on the head < tail FIFO indexes (real items are written into
	// slots[tail] before tail advances).
	const slotsLiteral = `[${"null,".repeat(FILTER_WORK_SLOT_COUNT).slice(0, -1)}]`;

	return `import { util } from "@aws-appsync/utils";

const FILTER_SPEC = ${filterSpecLiteral};

export function request(ctx) {
	const args = ctx.args;
	const size = Math.min(args.first || ${options.defaultPageSize}, ${options.maxPageSize});
	const searchAfter = args.after ? JSON.parse(util.base64Decode(args.after)) : undefined;

	const query = buildQuery(args.query, args.filter, args.searchFilter);
	const sort = buildSort(args.sortBy);

	const body = {
		size: size + 1,
		track_total_hits: ${options.trackTotalHitsUpTo},
		sort,
		query,${aggsBlock}
	};

	if (searchAfter) {
		body.search_after = searchAfter;
	}

	ctx.stash.queryBody = body;
	return { payload: null };
}

export function response(ctx) {
	return ctx.result;
}

function buildQuery(queryText, filter, searchFilter) {
	const musts = [];
	const filters = [];
	const mustNots = [];

	if (queryText) {
		musts.push({
			multi_match: {
				query: queryText,
				fields: ${textFieldsLiteral},
				type: "best_fields",
			},
		});
	}

	const keywordFields = ${keywordFieldsLiteral};
	if (filter) {
		for (const field of keywordFields) {
			if (filter[field] != null) {
				filters.push({ term: { [field]: filter[field] } });
			}
		}
	}

	if (searchFilter) {
		applyFilterSpec(FILTER_SPEC, searchFilter, filters, mustNots);
	}

	if (musts.length === 0 && filters.length === 0 && mustNots.length === 0) {
		return { match_all: {} };
	}

	return {
		bool: {
			...(musts.length > 0 ? { must: musts } : {}),
			...(filters.length > 0 ? { filter: filters } : {}),
			...(mustNots.length > 0 ? { must_not: mustNots } : {}),
		},
	};
}

function buildSort(sortBy) {
	const fallback = [{ _score: "desc" }, { _id: "asc" }];
	if (!sortBy || sortBy.length === 0) {
		return fallback;
	}
	const out = [];
	for (const entry of sortBy) {
		if (entry && entry.field) {
			const direction = entry.direction === "ASC" ? "asc" : "desc";
			out.push({ [entry.field]: direction });
		}
	}
	// Always tie-break on _id for stable cursor pagination.
	out.push({ _id: "asc" });
	return out;
}

function applyFilterSpec(rootSpec, rootInput, rootOutFilters, rootOutMustNots) {
	if (!rootSpec || !rootInput) return;

	// APPSYNC_JS forbids while, continue, C-style for(init;cond;update), and
	// the increment/decrement unary operators (lint rules @aws-appsync/no-while,
	// @aws-appsync/no-continue, @aws-appsync/no-for,
	// @aws-appsync/no-disallowed-unary-operators), and recursion
	// (@aws-appsync/no-recursion). It also does not honor the ECMA spec for
	// Array's @@iterator: items pushed during \`for...of\` iteration are NOT
	// visited (verified via aws appsync evaluate-code). Iteration is driven
	// by fixed-length slot pools whose \`for...of\` runs exactly slots.length
	// times; bodies check head/tail indexes to act on real work.
	//
	// Two pools, two phases (issue #110):
	//   procSlots — FIFO process queue. Each process item walks a spec list,
	//     enqueueing more process items for nested/object descents.
	//   finSlots — finalize stack drained LIFO after all processing is done.
	//     Each "nested" descent pushes one finalize item carrying the
	//     child-clause arrays and the path to wrap them with. LIFO ordering
	//     guarantees deepest-first wrapping, so an inner nested's clauses
	//     are wrapped onto its outer parent's child-clause array BEFORE
	//     that outer parent's finalize runs.
	//
	// The previous single-FIFO design ran a parent's finalize before
	// descendant processing finished whenever a non-nested struct ("object"
	// kind) sat between two leaves and a nested ancestor — the descendant
	// term clause landed in childFilters AFTER finalize had already drained
	// it, silently dropping the filter (issue #110). The same hazard
	// applies to nested-of-nested: outer finalize ran before inner finalize
	// populated its parent's child-clause array. Splitting process and
	// finalize into separate pools fixes both.
	const procSlots = ${slotsLiteral};
	const finSlots = ${slotsLiteral};
	procSlots[0] = {
		spec: rootSpec,
		input: rootInput,
		outFilters: rootOutFilters,
		outMustNots: rootOutMustNots,
	};
	let procHead = 0;
	let procTail = 1;
	let finTail = 0;

	for (const _slot of procSlots) {
		if (procHead < procTail) {
			const item = procSlots[procHead];
			procHead = procHead + 1;
			const spec = item.spec;
			const input = item.input;
			const outFilters = item.outFilters;
			const outMustNots = item.outMustNots;

			// FILTER_SPEC nodes use compact keys to fit under AppSync's 32 KB
			// per-function code cap (issue #99): i=inputName, k=kind, f=field,
			// p=path, c=children. See stringifyNode in the emitter. Range
			// kind carries one entry per field; the function expands the
			// four bound inputs (i+"Gte"/Lte/Gt/Lt) at iteration time
			// (issue #101).
			for (const node of spec) {
				const value = input[node.i];
				if (node.k === "nested") {
					if (value != null) {
						const childFilters = [];
						const childMustNots = [];
						if (procTail + 1 > procSlots.length) {
							util.error(
								"applyFilterSpec exceeded fixed work-slot capacity; SearchFilter shape too deep for APPSYNC_JS function",
							);
						}
						if (finTail + 1 > finSlots.length) {
							util.error(
								"applyFilterSpec exceeded fixed finalize-slot capacity; SearchFilter shape too deep for APPSYNC_JS function",
							);
						}
						procSlots[procTail] = {
							spec: node.c,
							input: value,
							outFilters: childFilters,
							outMustNots: childMustNots,
						};
						procTail = procTail + 1;
						finSlots[finTail] = {
							path: node.p,
							childFilters,
							childMustNots,
							parentFilters: outFilters,
							parentMustNots: outMustNots,
						};
						finTail = finTail + 1;
					}
				} else if (node.k === "object") {
					if (value != null) {
						if (procTail + 1 > procSlots.length) {
							util.error(
								"applyFilterSpec exceeded fixed work-slot capacity; SearchFilter shape too deep for APPSYNC_JS function",
							);
						}
						procSlots[procTail] = {
							spec: node.c,
							input: value,
							outFilters,
							outMustNots,
						};
						procTail = procTail + 1;
					}
				} else if (node.k === "term") {
					if (value != null) {
						outFilters.push({ term: { [node.f]: value } });
					}
				} else if (node.k === "term_negate") {
					if (value != null) {
						outMustNots.push({ term: { [node.f]: value } });
					}
				} else if (node.k === "terms") {
					if (value != null && value.length > 0) {
						outFilters.push({ terms: { [node.f]: value } });
					}
				} else if (node.k === "exists") {
					if (value != null) {
						if (value === true) {
							outFilters.push({ exists: { field: node.f } });
						} else {
							outMustNots.push({ exists: { field: node.f } });
						}
					}
				} else if (node.k === "nested_exists") {
					if (value != null) {
						const nestedClause = {
							nested: { path: node.p, query: { match_all: {} } },
						};
						if (value === true) {
							outFilters.push(nestedClause);
						} else {
							outMustNots.push(nestedClause);
						}
					}
				} else if (node.k === "range") {
					const base = node.i;
					const bounds = {};
					let any = false;
					if (input[base + "Gte"] != null) {
						bounds.gte = input[base + "Gte"];
						any = true;
					}
					if (input[base + "Lte"] != null) {
						bounds.lte = input[base + "Lte"];
						any = true;
					}
					if (input[base + "Gt"] != null) {
						bounds.gt = input[base + "Gt"];
						any = true;
					}
					if (input[base + "Lt"] != null) {
						bounds.lt = input[base + "Lt"];
						any = true;
					}
					if (any) {
						outFilters.push({ range: { [node.f]: bounds } });
					}
				}
			}
		}
	}

	// Finalize phase: drain LIFO. Deepest finalize first wraps its child
	// clauses onto its parent's childFilters/childMustNots array; that
	// parent's finalize, popped later, then sees those wrapped clauses and
	// wraps them in its own nested+path on the way to the grandparent.
	for (const _slot of finSlots) {
		if (finTail > 0) {
			finTail = finTail - 1;
			const item = finSlots[finTail];
			for (const clause of item.childFilters) {
				item.parentFilters.push({
					nested: {
						path: item.path,
						query: { bool: { filter: [clause] } },
					},
				});
			}
			for (const clause of item.childMustNots) {
				item.parentMustNots.push({
					nested: {
						path: item.path,
						query: { bool: { filter: [clause] } },
					},
				});
			}
		}
	}
}
`;
}

/**
 * Pipeline function on the OPENSEARCH datasource. Reads the pre-built body
 * from `ctx.stash.queryBody` (set by the prepare function) and issues the
 * OS HTTP request. Tiny on purpose — the heavy filter/aggs construction
 * lives in the prepare function where it has its own 32 KB budget.
 */
function renderSearchFunction(indexName: string): string {
	return `export function request(ctx) {
	return {
		operation: "GET",
		path: "/${indexName}/_search",
		params: { body: ctx.stash.queryBody },
	};
}

export function response(ctx) {
	return ctx.result;
}
`;
}

function renderFilterSpecLiteral(shape: SearchFilterShape | undefined): string {
	if (!shape) {
		return "[]";
	}
	return stringifySpec(shape.nodes);
}

function stringifySpec(nodes: FilterSpecNode[]): string {
	const items = nodes.map((node) => stringifyNode(node));
	return `[${items.join(", ")}]`;
}

function stringifyNode(node: FilterSpecNode): string {
	// FILTER_SPEC entries use single-letter keys to keep wide projections
	// under AppSync's 32 KB per-function code cap (issue #99). The reader is
	// applyFilterSpec inside the emitted prepare function; keys must match there:
	//   i = inputName, k = kind, f = field, p = path, c = children, b = bound.
	const i = JSON.stringify(node.inputName);
	if (node.kind === "nested") {
		const children = stringifySpec(node.children ?? []);
		return `{i:${i},k:"nested",p:${JSON.stringify(node.path ?? "")},c:${children}}`;
	}
	if (node.kind === "object") {
		const children = stringifySpec(node.children ?? []);
		return `{i:${i},k:"object",c:${children}}`;
	}
	if (node.kind === "nested_exists") {
		return `{i:${i},k:"nested_exists",p:${JSON.stringify(node.path ?? "")}}`;
	}
	if (node.kind === "range") {
		return `{i:${i},k:"range",f:${JSON.stringify(node.field ?? "")}}`;
	}
	return `{i:${i},k:${JSON.stringify(node.kind)},f:${JSON.stringify(node.field ?? "")}}`;
}

function renderAggsBlock(aggregations: AggregationEntry[]): string {
	if (aggregations.length === 0) {
		return "";
	}

	// Group aggs by nested path so each path emits ONE `nested` wrapper with all
	// child aggs inside, instead of one wrapper per agg. Saves a per-agg
	// `{ nested: { path: "..." }, aggs: { inner: ... } }` skeleton (~50 bytes
	// per nested agg) on wide projections (issue #105).
	//
	// Aggregations carry a per-projection-unique `aggName` (e.g. `byCounterpartyId`).
	// If the same aggName appears more than once (which can happen when a
	// projection spreads the same field/aggregation twice), APPSYNC_JS rejects
	// the resulting object literal at deploy time (TS1117 — duplicate keys).
	// Dedupe here, first-wins.
	const flatLines: string[] = [];
	const flatSeen = new Set<string>();
	const byPath = new Map<string, AggregationEntry[]>();
	const seenInPath = new Map<string, Set<string>>();
	for (const entry of aggregations) {
		if (!entry.nestedPath) {
			if (flatSeen.has(entry.aggName)) continue;
			flatSeen.add(entry.aggName);
			flatLines.push(`\t\t${entry.aggName}: ${renderAggInner(entry)},`);
			continue;
		}
		const seen = seenInPath.get(entry.nestedPath) ?? new Set<string>();
		if (seen.has(entry.aggName)) continue;
		seen.add(entry.aggName);
		seenInPath.set(entry.nestedPath, seen);
		const list = byPath.get(entry.nestedPath);
		if (list) {
			list.push(entry);
		} else {
			byPath.set(entry.nestedPath, [entry]);
		}
	}

	const groupLines: string[] = [];
	for (const [path, group] of byPath) {
		const inner = group
			.map((e) => `${e.aggName}: ${renderAggInner(e)}`)
			.join(", ");
		groupLines.push(
			`\t\t${nestedAggGroupKey(path)}: { nested: { path: ${JSON.stringify(path)} }, aggs: { ${inner} } },`,
		);
	}

	const lines = [...flatLines, ...groupLines];
	return `\n\t\taggs: {\n${lines.join("\n")}\n\t\t},`;
}

function nestedAggGroupKey(nestedPath: string): string {
	return `_${nestedPath.replace(/\./g, "_")}`;
}

function renderAggInner(entry: AggregationEntry): string {
	const aggType = osAggType(entry.kind);
	const fieldLit = JSON.stringify(entry.openSearchField);

	if (entry.kind === "date_histogram") {
		const interval =
			entry.options && "interval" in entry.options
				? entry.options.interval
				: "month";
		return `{ ${aggType}: { field: ${fieldLit}, calendar_interval: ${JSON.stringify(interval)} } }`;
	}
	if (entry.kind === "range") {
		const ranges =
			entry.options && "ranges" in entry.options ? entry.options.ranges : [];
		const rangesLit = JSON.stringify(ranges);
		return `{ ${aggType}: { field: ${fieldLit}, ranges: ${rangesLit} } }`;
	}
	if (entry.kind === "terms" && entry.options) {
		const opts = entry.options as {
			sub?: Record<string, { kind: string; field: string }>;
			topHits?: number;
		};
		const subEntries = Object.entries(opts.sub ?? {});
		const hasSub = subEntries.length > 0;
		const hasTopHits = typeof opts.topHits === "number" && opts.topHits > 0;
		if (!hasSub && !hasTopHits) {
			return `{ ${aggType}: { field: ${fieldLit} } }`;
		}
		const subLines = subEntries.map(
			([name, spec]) =>
				`${JSON.stringify(name)}: { ${spec.kind}: { field: ${JSON.stringify(spec.field)} } }`,
		);
		if (hasTopHits) {
			subLines.push(`"hits": { top_hits: { size: ${opts.topHits} } }`);
		}
		return `{ ${aggType}: { field: ${fieldLit} }, aggs: { ${subLines.join(", ")} } }`;
	}
	return `{ ${aggType}: { field: ${fieldLit} } }`;
}

function renderResponseAggregationsPreamble(
	aggregations: AggregationEntry[],
): string {
	if (aggregations.length === 0) {
		return "";
	}
	// Hoist `parsedBody.aggregations` and per-nested-path subtrees into short
	// locals so per-agg lines stay compact. With many nested aggs the
	// difference dominates resolver size; together with nested-path grouping
	// this keeps wide @searchInfer projections under AppSync's 32 KB cap
	// (issue #105).
	const lines = ["\tconst _a = parsedBody.aggregations || {};"];
	const seen = new Set<string>();
	for (const entry of aggregations) {
		if (!entry.nestedPath || seen.has(entry.nestedPath)) continue;
		seen.add(entry.nestedPath);
		const groupKey = nestedAggGroupKey(entry.nestedPath);
		lines.push(`\tconst _a${groupKey} = _a.${groupKey} || {};`);
	}
	return lines.join("\n");
}

function renderResponseAggregations(aggregations: AggregationEntry[]): string {
	if (aggregations.length === 0) {
		return "";
	}

	// Match the dedupe in renderAggsBlock — first-wins on duplicate aggName.
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const entry of aggregations) {
		if (seen.has(entry.aggName)) continue;
		seen.add(entry.aggName);
		lines.push(renderResponseAggregationLine(entry));
	}

	return `\n\t\taggregations: {\n${lines.join("\n")}\n\t\t},`;
}

function renderResponseAggregationLine(entry: AggregationEntry): string {
	const path = entry.nestedPath
		? `_a${nestedAggGroupKey(entry.nestedPath)}.${entry.aggName}`
		: `_a.${entry.aggName}`;
	switch (entry.kind) {
		case "terms": {
			const opts = (entry.options ?? {}) as {
				sub?: Record<string, unknown>;
				topHits?: number;
			};
			const subEntries = Object.entries(opts.sub ?? {});
			const hasTopHits = typeof opts.topHits === "number" && opts.topHits > 0;
			if (subEntries.length === 0 && !hasTopHits) {
				return `\t\t\t${entry.aggName}: (${path}?.buckets ?? []).map((b) => ({ key: b.key, count: b.doc_count })),`;
			}
			const subFields = subEntries
				.map(([name]) => `, ${name}: b.${name}?.value ?? null`)
				.join("");
			const hitsField = hasTopHits
				? `, hits: (b.hits?.hits?.hits ?? []).map((h) => h._source)`
				: "";
			return `\t\t\t${entry.aggName}: (${path}?.buckets ?? []).map((b) => ({ key: b.key, count: b.doc_count${subFields}${hitsField} })),`;
		}
		case "cardinality":
			return `\t\t\t${entry.aggName}: ${path}?.value ?? 0,`;
		case "missing":
			return `\t\t\t${entry.aggName}: ${path}?.doc_count ?? 0,`;
		case "sum":
		case "avg":
		case "min":
		case "max":
			return `\t\t\t${entry.aggName}: ${path}?.value ?? null,`;
		case "date_histogram":
			// Template-literal coercion only — APPSYNC_JS rejects String() at
			// deploy time, and the eslint-plugin doesn't flag global function
			// calls. Both `key` and `keyAsString` are surfaced so callers can
			// access the formatted-date form OS provides for calendar_interval.
			return `\t\t\t${entry.aggName}: (${path}?.buckets ?? []).map((b) => ({ key: \`\${b.key_as_string ?? b.key}\`, keyAsString: b.key_as_string ?? null, count: b.doc_count })),`;
		case "range":
			return `\t\t\t${entry.aggName}: (${path}?.buckets ?? []).map((b) => ({ key: b.key, from: b.from ?? null, to: b.to ?? null, count: b.doc_count })),`;
	}
}

function osAggType(kind: AggregationEntry["kind"]): string {
	switch (kind) {
		case "terms":
			return "terms";
		case "cardinality":
			return "cardinality";
		case "missing":
			return "missing";
		case "date_histogram":
			return "date_histogram";
		case "range":
			return "range";
		case "sum":
			return "sum";
		case "avg":
			return "avg";
		case "min":
			return "min";
		case "max":
			return "max";
	}
}

export const __test = {
	hasTextType,
	renderResolver,
	renderPrepareFunction,
	renderSearchFunction,
	renderMonolithicResolver,
	renderAggsBlock,
	renderResponseAggregations,
	DEFAULT_INTERN_STRINGS,
	DEFAULT_MONOLITHIC_THRESHOLD_BYTES,
};
