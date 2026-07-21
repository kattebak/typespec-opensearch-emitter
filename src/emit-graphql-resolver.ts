import { type AggregationEntry, collectAggregations } from "./aggregations.js";
import {
	type DateHistogramOptions,
	supportsMinimumInterval,
} from "./decorators.js";
import { toGraphQLQueryFieldName } from "./emit-graphql-sdl.js";
import {
	buildSearchFilterShape,
	type FilterSpecNode,
	type SearchFilterShape,
} from "./filters.js";
import type {
	ResolvedProjection,
	ResolvedProjectionField,
	TopLevelProjection,
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
	 * Byte threshold above which a projection's monolithic shape is rejected
	 * and the pipeline shape is emitted instead. Suggested 28,000 (32K cap
	 * minus headroom). Measured against the rendered monolithic content.
	 */
	monolithicThresholdBytes?: number;
	/**
	 * `buckets` for the `auto_date_histogram` emitted when a date_histogram
	 * aggregation declares no bounds. See DEFAULT_AUTO_DATE_HISTOGRAM_BUCKETS.
	 */
	autoDateHistogramBuckets?: number;
}

const DEFAULT_MONOLITHIC_THRESHOLD_BYTES = 32_000;

/**
 * Per-histogram `buckets` ceiling for a bounds-less `auto_date_histogram`
 * (issue #150). This is the most any single histogram gets; the emitted
 * `buildAggs` lowers it when a request selects several histograms so their sum
 * stays under the per-request budget (issue #155).
 *
 * `auto_date_histogram` returns at most this many buckets, picking the finest
 * interval at or above `minimum_interval` that fits. The value therefore sets
 * how wide a range still keeps the author's declared interval: at 10,000 that
 * is 833 years of monthly buckets, 27 years of daily, and 1.1 years of hourly
 * — past any real corpus, so declared intervals survive. A 9999-12-31 sentinel
 * (~96,000 months) does not fit and steps down to yearly (~8,000 buckets),
 * which renders instead of failing.
 */
export const DEFAULT_AUTO_DATE_HISTOGRAM_BUCKETS = 10_000;

/**
 * Soft per-request bucket budget: a third of OpenSearch's default
 * `search.max_buckets` (65,535). That cap counts every bucket in the whole
 * request, not one aggregation, so the emitted `buildAggs` divides this budget
 * across the `auto_date_histogram` aggregations a request actually selects
 * (issue #155). A request that reaches the hard cap is already a 503; a third
 * leaves room for the terms and metric buckets sharing the request.
 */
export const PER_REQUEST_BUCKET_BUDGET = 21_845;

/**
 * Lower bound on the per-histogram bucket count after the budget is divided, so
 * a request selecting many histograms still renders a legible chart instead of
 * a handful of buckets. Below ~256 buckets a time series stops being readable;
 * this floor only binds past ~85 selected histograms.
 */
export const MIN_AUTO_DATE_HISTOGRAM_BUCKETS = 256;

/**
 * Module-level helper the emitted AGG_SPEC calls for each bounds-less
 * date_histogram. The `auto_date_histogram` key is long and repeats across
 * every such entry, so factoring it out of the literal keeps wide projections
 * under AppSync's 32 KB per-function cap (issues #99, #105). `buckets` is set
 * per request by `buildAggs`, not baked here, so it can vary with how many
 * histograms a request selects (issue #155).
 */
const AUTO_DATE_HISTOGRAM_HELPER = "ADH";

/**
 * Module-level helper the emitted free-text clause calls for each `@nested`
 * sub-projection carrying searchable text. The nested-query skeleton is long
 * and identical bar the path and field list, so factoring it out of the
 * literal keeps wide projections under AppSync's 32 KB per-function cap —
 * the same move as AUTO_DATE_HISTOGRAM_HELPER, and the fix issue #105 applied
 * to the repeated nested-doc skeletons. The call sites stay static literals:
 * no spec array, no runtime walk.
 */
const NESTED_TEXT_QUERY_HELPER = "NQ";

// Bound for the runtime applyFilterSpec walker's fixed-size work slot pool.
// APPSYNC_JS does not honor self-extending Array iteration, so the emitted
// function pre-allocates this many slots as a literal. Set well above any
// realistic SearchFilter shape; runtime util.error fires if exceeded.
const FILTER_WORK_SLOT_COUNT = 256;

export async function emitGraphQLResolver(
	projection: TopLevelProjection,
	options: ResolverOptions,
): Promise<EmittedResolverFile> {
	const typeName = projection.projectionModel.name;
	const queryFieldName = toGraphQLQueryFieldName(typeName);
	const baseName = toKebabCase(typeName);

	const textFields = collectTextFields(projection);

	const keywordFields = projection.fields
		.filter((f) => f.searchable && f.keyword)
		.map((f) => f.projectedName ?? f.name);

	// Sortable fields that map to OpenSearch `text` (string, no @keyword,
	// no nested, no sub-projection). OpenSearch refuses to sort on `text`
	// — the request fails with `UserIllegalArgumentException: Text fields
	// are not optimised for operations that require per-document field
	// data ...`. The emit-mapping layer always adds a `.keyword` subfield
	// for these (see emit-mapping.ts mapString), so the resolver suffixes
	// `.keyword` on the sort target at runtime. Closes #126.
	const textSortFields = projection.fields
		.filter(
			(f) =>
				f.sortable &&
				!f.keyword &&
				!f.nested &&
				!f.subProjection &&
				hasTextType(f),
		)
		.map((f) => f.projectedName ?? f.name);

	const aggregations = collectAggregations(projection);
	const searchFilterShape = buildSearchFilterShape(projection);

	const threshold =
		options.monolithicThresholdBytes ?? DEFAULT_MONOLITHIC_THRESHOLD_BYTES;

	// Stage 1 of the two-stage emit (issue #112): render the monolithic UNIT
	// shape and measure. Under the threshold we ship monolithic — saves ~50ms
	// median per query (pipeline-dispatch I/O). Over the threshold we fall
	// back to the pipeline split (issue #105).
	const monolithicContent = renderMonolithicResolver(
		textFields,
		keywordFields,
		textSortFields,
		aggregations,
		searchFilterShape,
		projection.indexName,
		options,
	);
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

	// Pipeline fallback. The resolver-level file holds the after-mapping;
	// prepare runs on NONE, search on OPENSEARCH (issue #105).
	const prepareContent = renderPrepareFunction(
		textFields,
		keywordFields,
		textSortFields,
		aggregations,
		searchFilterShape,
		options,
	);
	const searchContent = renderSearchFunction(projection.indexName);
	const resolverContent = renderResolver(aggregations, options);

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

/**
 * Free-text fields grouped by the query clause they belong in. `flat` holds
 * root-document paths — top-level fields plus `object`-mapped sub-projection
 * fields, which live in the same Lucene document and so are reachable by a
 * dotted path. `nested` holds one group per `@nested` sub-projection that
 * carries at least one `@searchable` text field; those are separate hidden
 * documents, reachable only through a `nested` query naming their path.
 */
interface NestedTextGroup {
	path: string;
	fields: string[];
}

interface TextFieldCollection {
	flat: string[];
	nested: NestedTextGroup[];
}

/**
 * Path-threading walk over the projection tree, mirroring the filter path's
 * `buildShapeRecursive` (filters.ts). `@searchable` on a sub-projection's
 * field is recorded in that sub-projection's own `fields` array, so a flat
 * pass over `projection.fields` never sees it — the mapping emitter recurses,
 * the resolver did not, and nested `@searchable` was inert (issue #158).
 *
 * Every path is fully known here, so the emitted clause is a static literal:
 * no runtime spec-walking, and none of the APPSYNC_JS control-flow
 * constraints that shape `applyFilterSpec` apply.
 */
function collectTextFields(
	projection: ResolvedProjection,
): TextFieldCollection {
	const collection: TextFieldCollection = { flat: [], nested: [] };
	collectTextFieldsRecursive(projection, undefined, undefined, collection);
	return collection;
}

function collectTextFieldsRecursive(
	projection: ResolvedProjection,
	fieldPrefix: string | undefined,
	nestedPath: string | undefined,
	collection: TextFieldCollection,
): void {
	if (!projection.fields) return;

	for (const field of projection.fields) {
		const path = joinFieldPath(fieldPrefix, field.projectedName ?? field.name);

		if (field.subProjection) {
			// A `nested` sub-projection opens a new nested document; an `object`
			// one keeps the current document and only extends the dotted path.
			// OpenSearch accepts a fully-qualified inner path on a `nested`
			// query, so nesting within nesting groups by the innermost path.
			collectTextFieldsRecursive(
				field.subProjection,
				path,
				field.nested ? path : nestedPath,
				collection,
			);
			continue;
		}

		if (
			!field.searchable ||
			field.keyword ||
			field.nested ||
			!hasTextType(field)
		) {
			continue;
		}

		if (!nestedPath) {
			collection.flat.push(path);
			continue;
		}

		const group = collection.nested.find((g) => g.path === nestedPath);
		if (group) {
			group.fields.push(path);
			continue;
		}
		collection.nested.push({ path: nestedPath, fields: [path] });
	}
}

function joinFieldPath(parent: string | undefined, segment: string): string {
	return parent ? `${parent}.${segment}` : segment;
}

/**
 * Declaration of the nested-query helper, emitted only when the projection has
 * nested text to search. `score_mode: "max"` scores a parent document by its
 * best-matching child rather than by a sum over children, so one strong hit
 * ranks a parent the way a root-field hit would.
 */
function renderNestedTextHelper(textFields: TextFieldCollection): string {
	if (textFields.nested.length === 0) return "";

	return `
function ${NESTED_TEXT_QUERY_HELPER}(path, fields, queryText) {
	return { nested: { path, score_mode: "max", query: { multi_match: { query: queryText, fields, type: "best_fields", lenient: true } } } };
}
`;
}

/**
 * Module-level `TEXT_FIELDS`/`NESTED_TEXT_GROUPS` data the free-text clause
 * reads at request time (issue #168). One `NQ(...)` call site per nested
 * group scales the generated code with sub-model count — on a document with
 * many `@nested` sub-projections (the counterparty shape: 15 groups) that
 * approaches AppSync's 32 KB per-function cap even with the group's skeleton
 * already factored into a helper. Emitting the (path, fields) pairs as a data
 * array and looping over it at runtime keeps the code flat regardless of
 * group count. Empty when there is no nested searchable text — the flat-only
 * clause stays a static literal (see `renderTextQueryPush`).
 */
function renderTextSpecDeclaration(textFields: TextFieldCollection): string {
	if (textFields.nested.length === 0) return "";

	const flatLiteral = JSON.stringify(textFields.flat);
	const groupsLiteral = `[${textFields.nested
		.map((g) => `[${JSON.stringify(g.path)},${JSON.stringify(g.fields)}]`)
		.join(",")}]`;

	return `
const TEXT_FIELDS = ${flatLiteral};
const NESTED_TEXT_GROUPS = ${groupsLiteral};
`;
}

/**
 * The `musts.push(...)` for the free-text clause. With no nested text fields
 * this is the flat `multi_match` — byte-identical to what the emitter has
 * always produced, so projections without nested `@searchable` are untouched.
 * Otherwise the loop reads `TEXT_FIELDS`/`NESTED_TEXT_GROUPS` (declared by
 * `renderTextSpecDeclaration`) and builds one `nested`-wrapped `multi_match`
 * per group into a `bool.should` alongside the root-document clause;
 * `minimum_should_match: 1` keeps the clause a real constraint rather than a
 * scoring hint. Same shoulds, same order, same clause shapes as the previous
 * per-group unroll — only the code that builds them changed.
 */
function renderTextQueryPush(textFields: TextFieldCollection): string {
	const flatLiteral = JSON.stringify(textFields.flat);

	if (textFields.nested.length === 0) {
		return `		musts.push({
			multi_match: {
				query: queryText,
				fields: ${flatLiteral},
				type: "best_fields",
				lenient: true,
			},
		});`;
	}

	// A projection whose only searchable text lives in nested sub-models has
	// no root-document fields to match, and `multi_match` with an empty
	// `fields` falls back to querying every field — so omit the flat clause
	// rather than emit one that matches on paths nobody marked @searchable.
	return `		const shoulds = [];
		if (TEXT_FIELDS.length > 0) {
			shoulds.push({ multi_match: { query: queryText, fields: TEXT_FIELDS, type: "best_fields", lenient: true } });
		}
		for (const group of NESTED_TEXT_GROUPS) {
			shoulds.push(${NESTED_TEXT_QUERY_HELPER}(group[0], group[1], queryText));
		}
		musts.push({
			bool: {
				should: shoulds,
				minimum_should_match: 1,
			},
		});`;
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
/**
 * `buildSort` — identical between the monolithic and pipeline shapes, so it
 * is rendered once and shared rather than duplicated per emit mode.
 */
function renderBuildSortFunction(): string {
	return `function buildSort(sortBy) {
	const fallback = [{ _score: "desc" }, { _id: "asc" }];
	if (!sortBy || sortBy.length === 0) {
		return fallback;
	}
	const out = [];
	for (const entry of sortBy) {
		if (entry && entry.field) {
			const direction = entry.direction === "ASC" ? "asc" : "desc";
			// OpenSearch refuses to sort on \`text\` fields. The emit-mapping
			// layer always adds a \`.keyword\` subfield for sortable text
			// fields, so target that subfield at runtime.
			const target = TEXT_SORT_FIELDS.indexOf(entry.field) >= 0
				? entry.field + ".keyword"
				: entry.field;
			out.push({ [target]: direction });
		}
	}
	out.push({ _id: "asc" });
	return out;
}
`;
}

/**
 * `applyFilterSpec` — identical between the monolithic and pipeline shapes,
 * so it is rendered once and shared rather than duplicated per emit mode.
 * See FILTER_SPEC/stringifyNode for the compact node encoding this walks,
 * and issues #99, #101, #105, #110 for why the walk uses fixed-size slot
 * pools instead of recursion or growable arrays (APPSYNC_JS constraints).
 */
function renderApplyFilterSpecFunction(slotsLiteral: string): string {
	return `function applyFilterSpec(rootSpec, rootInput, rootOutFilters, rootOutMustNots) {
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
				} else if (node.k === "prefix") {
					if (value != null && value !== "") {
						outFilters.push({ prefix: { [node.f]: value } });
					}
				} else if (node.k === "match") {
					if (value != null && value !== "") {
						outFilters.push({ match: { [node.f]: value } });
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

function renderMonolithicResolver(
	textFields: TextFieldCollection,
	keywordFields: string[],
	textSortFields: string[],
	aggregations: AggregationEntry[],
	searchFilterShape: SearchFilterShape | undefined,
	indexName: string,
	options: ResolverOptions,
): string {
	const textQueryPush = renderTextQueryPush(textFields);
	const textSpecDeclaration = renderTextSpecDeclaration(textFields);
	const nestedTextHelper = renderNestedTextHelper(textFields);
	const keywordFieldsLiteral = JSON.stringify(keywordFields);
	const textSortFieldsLiteral = JSON.stringify(textSortFields);
	const aggsAssignment = renderAggsAssignment(aggregations, "\t");
	const aggSpecDeclaration = renderAggSpecDeclaration(aggregations);
	const buildAggsFunction = renderBuildAggsFunction(aggregations, options);
	const filterSpecLiteral = renderFilterSpecLiteral(searchFilterShape);
	const slotsLiteral = `[${"null,".repeat(FILTER_WORK_SLOT_COUNT).slice(0, -1)}]`;
	const buildSortFunction = renderBuildSortFunction();
	const applyFilterSpecFunction = renderApplyFilterSpecFunction(slotsLiteral);
	const responseAggregationsPreamble =
		renderResponseAggregationsPreamble(aggregations);
	const responseAggregations = renderResponseAggregations(aggregations);

	return `import { util } from "@aws-appsync/utils";

const FILTER_SPEC = ${filterSpecLiteral};
${aggSpecDeclaration}
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
		query,
	};

	if (searchAfter) {
		body.search_after = searchAfter;
	}
${aggsAssignment}
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
${renderSearchBodyGuard("parsedBody", "\t")}	const hits = parsedBody.hits.hits;
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
${buildAggsFunction}${textSpecDeclaration}${nestedTextHelper}
function buildQuery(queryText, filter, searchFilter) {
	const musts = [];
	const filters = [];
	const mustNots = [];

	if (queryText) {
${textQueryPush}
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

const TEXT_SORT_FIELDS = ${textSortFieldsLiteral};

${buildSortFunction}
${applyFilterSpecFunction}`;
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
${renderSearchBodyGuard("parsedBody", "\t")}	const hits = parsedBody.hits.hits;
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
	textFields: TextFieldCollection,
	keywordFields: string[],
	textSortFields: string[],
	aggregations: AggregationEntry[],
	searchFilterShape: SearchFilterShape | undefined,
	options: ResolverOptions,
): string {
	const textQueryPush = renderTextQueryPush(textFields);
	const textSpecDeclaration = renderTextSpecDeclaration(textFields);
	const nestedTextHelper = renderNestedTextHelper(textFields);
	const keywordFieldsLiteral = JSON.stringify(keywordFields);
	const textSortFieldsLiteral = JSON.stringify(textSortFields);
	const aggsAssignment = renderAggsAssignment(aggregations, "\t");
	const aggSpecDeclaration = renderAggSpecDeclaration(aggregations);
	const buildAggsFunction = renderBuildAggsFunction(aggregations, options);
	const filterSpecLiteral = renderFilterSpecLiteral(searchFilterShape);
	// `null` (4 chars) instead of `undefined` (9 chars) keeps the literal small
	// — saves ~5 bytes per slot. The walker never reads these init values; it
	// gates work on the head < tail FIFO indexes (real items are written into
	// slots[tail] before tail advances).
	const slotsLiteral = `[${"null,".repeat(FILTER_WORK_SLOT_COUNT).slice(0, -1)}]`;
	const buildSortFunction = renderBuildSortFunction();
	const applyFilterSpecFunction = renderApplyFilterSpecFunction(slotsLiteral);

	return `import { util } from "@aws-appsync/utils";

const FILTER_SPEC = ${filterSpecLiteral};
${aggSpecDeclaration}
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
		query,
	};

	if (searchAfter) {
		body.search_after = searchAfter;
	}
${aggsAssignment}
	ctx.stash.queryBody = body;
	return { payload: null };
}

export function response(ctx) {
	return ctx.result;
}
${buildAggsFunction}${textSpecDeclaration}${nestedTextHelper}
function buildQuery(queryText, filter, searchFilter) {
	const musts = [];
	const filters = [];
	const mustNots = [];

	if (queryText) {
${textQueryPush}
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

const TEXT_SORT_FIELDS = ${textSortFieldsLiteral};

${buildSortFunction}
${applyFilterSpecFunction}`;
}

/**
 * Pipeline function on the OPENSEARCH datasource. Reads the pre-built body
 * from `ctx.stash.queryBody` (set by the prepare function) and issues the
 * OS HTTP request. Tiny on purpose — the heavy filter/aggs construction
 * lives in the prepare function where it has its own 32 KB budget.
 *
 * The response handler must fail loudly (issue #150): returning `ctx.result`
 * unchecked lets a failed search through as `undefined`, which the resolver
 * after-mapping then dereferences — the AppSync JS runtime reports that as
 * `ReferenceError: parsedBody is not defined`, naming neither the status code
 * nor the OpenSearch reason.
 */
function renderSearchFunction(indexName: string): string {
	return `import { util } from "@aws-appsync/utils";

export function request(ctx) {
	return {
		operation: "GET",
		path: "/${indexName}/_search",
		params: { body: ctx.stash.queryBody },
	};
}

export function response(ctx) {
	if (ctx.error) {
		return util.error(ctx.error.message, ctx.error.type, null, ctx.result);
	}
${renderSearchBodyGuard("ctx.result", "\t")}	return ctx.result;
}
`;
}

/**
 * Guard an OpenSearch response body before anything dereferences `.hits`.
 *
 * Covers three failure shapes the datasource can hand back without setting
 * `ctx.error`: a missing body, an OpenSearch error envelope
 * (`{ error: { type, reason }, status }` — this is how `too_many_buckets_exception`
 * arrives), and a raw non-2xx HTTP response (`{ statusCode, body }`). Each one
 * surfaces the real type and reason instead of a phantom ReferenceError one
 * line later.
 *
 * The body travels as `errorInfo` (4th arg), not `data` (3rd): AppSync filters
 * `data` against the field's query selection set, and an OpenSearch body
 * (`hits`/`error`/`status`) shares no field with a Connection selection
 * (`totalCount`/`edges`/`aggregations`), so it would filter down to nothing and
 * never reach the client. `errorInfo` is not filtered.
 */
function renderSearchBodyGuard(expr: string, indent: string): string {
	const i = indent;
	return `${i}if (!${expr} || !${expr}.hits) {
${i}	const err = ${expr} ? ${expr}.error : null;
${i}	const status = ${expr} ? ${expr}.status || ${expr}.statusCode : null;
${i}	return util.error(
${i}		(err && err.reason) || "OpenSearch search failed" + (status ? " with status " + status : "") + ": " + JSON.stringify(${expr}),
${i}		(err && err.type) || "OpenSearchError",
${i}		null,
${i}		${expr},
${i}	);
${i}}
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

/**
 * Emits the `AGG_SPEC` module-level declaration: one entry per aggregation the
 * projection declares, keyed by the GraphQL field name the caller selects it
 * under. `buildAggs` reads it at request time. Returns "" when the projection
 * has no aggregations at all.
 */
function renderAggSpecDeclaration(aggregations: AggregationEntry[]): string {
	if (aggregations.length === 0) {
		return "";
	}
	const helper = aggregations.some(usesAutoDateHistogram)
		? `\nconst ${AUTO_DATE_HISTOGRAM_HELPER} = (f, m) => ({ auto_date_histogram: { field: f, minimum_interval: m } });\n`
		: "";
	return `${helper}\nconst AGG_SPEC = ${renderAggSpecLiteral(aggregations)};\n`;
}

/**
 * True when the entry renders through the AUTO_DATE_HISTOGRAM_HELPER: a
 * date_histogram with no author-declared bounds, at an interval OpenSearch can
 * express as a `minimum_interval`.
 */
/**
 * `,h:1` marks an AGG_SPEC entry that renders through the helper, so buildAggs
 * can count it against the per-request bucket budget and set its `buckets`
 * (issue #155). Empty for every other aggregation kind.
 */
function histogramFlag(entry: AggregationEntry): string {
	return usesAutoDateHistogram(entry) ? ",h:1" : "";
}

function usesAutoDateHistogram(entry: AggregationEntry): boolean {
	if (entry.kind !== "date_histogram") {
		return false;
	}
	const opts =
		entry.options && "interval" in entry.options
			? (entry.options as DateHistogramOptions)
			: undefined;
	if (opts?.bounds) {
		return false;
	}
	return supportsMinimumInterval(opts?.interval ?? "month");
}

/**
 * Builds the `[{n:"byTagName",a:{...}}, {n:"byStatus",g:"_tags",p:"tags",a:{...}}]`
 * literal that `buildAggs` projects the caller's selection onto.
 *
 * AGG_SPEC entries use single-letter keys to keep wide projections under
 * AppSync's 32 KB per-function code cap (issue #99, #105). The reader is
 * buildAggs inside the emitted prepare function; keys must match there:
 *   n = GraphQL aggregation field name, a = OpenSearch agg body,
 *   p = nested path, g = nested agg group key.
 *
 * Flat aggregations come first, then nested ones grouped by path, so the
 * assembled `body.aggs` key order matches the projection's declaration order.
 *
 * Aggregations carry a per-projection-unique `aggName` (e.g. `byCounterpartyId`).
 * If the same aggName appears more than once (which can happen when a
 * projection spreads the same field/aggregation twice), the duplicate would
 * overwrite the first at assembly time. Dedupe here, first-wins, matching the
 * response-side mapping.
 */
function renderAggSpecLiteral(aggregations: AggregationEntry[]): string {
	if (aggregations.length === 0) {
		return "[]";
	}

	const flatItems: string[] = [];
	const flatSeen = new Set<string>();
	const byPath = new Map<string, AggregationEntry[]>();
	const seenInPath = new Map<string, Set<string>>();
	for (const entry of aggregations) {
		if (!entry.nestedPath) {
			if (flatSeen.has(entry.aggName)) continue;
			flatSeen.add(entry.aggName);
			flatItems.push(
				`{n:${JSON.stringify(entry.aggName)},a:${renderAggInner(entry)}${histogramFlag(entry)}}`,
			);
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

	const groupItems: string[] = [];
	for (const [path, group] of byPath) {
		const groupKey = JSON.stringify(nestedAggGroupKey(path));
		const pathLit = JSON.stringify(path);
		for (const entry of group) {
			groupItems.push(
				`{n:${JSON.stringify(entry.aggName)},g:${groupKey},p:${pathLit},a:${renderAggInner(entry)}${histogramFlag(entry)}}`,
			);
		}
	}

	return `[${[...flatItems, ...groupItems].join(", ")}]`;
}

/**
 * Emits the `buildAggs` runtime helper, which projects the caller's selection
 * onto AGG_SPEC. APPSYNC_JS exposes `ctx.info.selectionSetList` as an array of
 * slash-paths into the selection set; an aggregation is requested exactly when
 * `aggregations/<aggName>` is present.
 *
 * Only requested aggregations reach OpenSearch, and a nested wrapper is built
 * only for groups with at least one requested child (issue #150). Assembling
 * at runtime from a compact spec keeps the emitted code size flat regardless
 * of how many aggregations the projection declares — the alternative, emitting
 * a per-selection object literal, does not fit the 32 KB per-function cap.
 *
 * `selectionSetList` names an aliased field by its alias only — the schema
 * field name is absent — so `aggregations { s: bySpecies { key } }` yields
 * `aggregations/s` and nothing that identifies `bySpecies`. The alias target is
 * not recoverable, so buildAggs detects the alias instead: the valid children of
 * `aggregations` are the AGG_SPEC names plus `__typename`, which Apollo, Amplify
 * and Relay inject into every object selection set; any other first segment is
 * read as an alias. Such a selection falls back to sending every aggregation,
 * which is what the caller received before issue #150 narrowed the block.
 *
 * Known false negative: an alias that happens to name another declared
 * aggregation (`byAlias: bySpecies`) reads as declared, so no fallback fires and
 * the wrong aggregation is sent — undetectable from `selectionSetList` alone.
 *
 * Each selected `auto_date_histogram` (marked `h:1`) has its `buckets` set from
 * a per-request budget divided across the histograms actually sent, so their
 * sum stays under OpenSearch's `search.max_buckets` however many are selected
 * (issue #155). The alias fallback selects every aggregation, so its histograms
 * count toward the same budget.
 *
 * Returns "" when the projection has no aggregations at all.
 */
function renderBuildAggsFunction(
	aggregations: AggregationEntry[],
	options: ResolverOptions,
): string {
	if (aggregations.length === 0) {
		return "";
	}
	const cap =
		options.autoDateHistogramBuckets ?? DEFAULT_AUTO_DATE_HISTOGRAM_BUCKETS;
	// Only projections with a bounds-less date_histogram carry `h:1` markers, so
	// only they need the per-request budget division (issue #155). Everything
	// else keeps the leaner selection-only assembly.
	const hasAuto = aggregations.some(usesAutoDateHistogram);
	const trackHistogram = hasAuto
		? "\n\t\t\tif (spec.h) histograms.push(spec);"
		: "";
	const histogramDecl = hasAuto ? "\n\tconst histograms = [];" : "";
	const budgetBlock = hasAuto
		? `
	// search.max_buckets caps the whole request: divide a soft budget across the
	// selected histograms, capped and floored per histogram (issue #155).
	if (histograms.length > 0) {
		let budget = Math.floor(${PER_REQUEST_BUCKET_BUDGET} / histograms.length);
		if (budget > ${cap}) budget = ${cap};
		if (budget < ${MIN_AUTO_DATE_HISTOGRAM_BUCKETS}) budget = ${MIN_AUTO_DATE_HISTOGRAM_BUCKETS};
		for (const spec of histograms) {
			spec.a.auto_date_histogram.buckets = budget;
		}
	}`
		: "";
	return `
function buildAggs(selectionSetList) {
	// A first segment under \`aggregations/\` naming no AGG_SPEC entry is an
	// alias, whose target is not recoverable here — send every aggregation
	// rather than none.
	let aliased = false;
	for (const path of selectionSetList) {
		if (path.indexOf("aggregations/") === 0) {
			const rest = path.substring(13);
			const slash = rest.indexOf("/");
			const name = slash < 0 ? rest : rest.substring(0, slash);
			let declared = false;
			for (const spec of AGG_SPEC) {
				if (spec.n === name) declared = true;
			}
			if (!declared && name !== "__typename") aliased = true;
		}
	}
	// \`null\` means nothing was requested, and the request omits \`aggs\` entirely.
	const aggs = {};
	let requested = false;${histogramDecl}
	for (const spec of AGG_SPEC) {
		if (aliased || selectionSetList.indexOf("aggregations/" + spec.n) >= 0) {
			requested = true;${trackHistogram}
			if (spec.g) {
				const group = aggs[spec.g] || { nested: { path: spec.p }, aggs: {} };
				group.aggs[spec.n] = spec.a;
				aggs[spec.g] = group;
			} else {
				aggs[spec.n] = spec.a;
			}
		}
	}${budgetBlock}
	return requested ? aggs : null;
}
`;
}

/**
 * Emits the request-side block that assigns `body.aggs` to the aggregations the
 * caller selected, and leaves the key off entirely when they selected none.
 *
 * Sending only the requested aggregations keeps OpenSearch from executing every
 * aggregation the doc type declares on a `searchX(first: 0) { totalCount }`
 * style probe, and isolates each aggregation's failures to the queries that ask
 * for it. Returns "" when the projection has no aggregations at all.
 */
function renderAggsAssignment(
	aggregations: AggregationEntry[],
	indent: string,
): string {
	if (aggregations.length === 0) {
		return "";
	}
	return `${indent}const aggs = buildAggs(ctx.info.selectionSetList);
${indent}if (aggs) {
${indent}\tbody.aggs = aggs;
${indent}}
`;
}

function nestedAggGroupKey(nestedPath: string): string {
	return `_${nestedPath.replace(/\./g, "_")}`;
}

function renderAggInner(entry: AggregationEntry): string {
	const aggType = osAggType(entry.kind);
	const fieldLit = JSON.stringify(entry.openSearchField);

	if (entry.kind === "date_histogram") {
		const opts =
			entry.options && "interval" in entry.options
				? (entry.options as DateHistogramOptions)
				: undefined;
		const interval = opts?.interval ?? "month";
		const intervalLit = JSON.stringify(interval);
		// Author-declared bounds pin the range, so the declared interval can
		// never blow the bucket count: emit the real thing.
		if (opts?.bounds) {
			return `{ ${aggType}: { field: ${fieldLit}, calendar_interval: ${intervalLit}, hard_bounds: ${JSON.stringify(opts.bounds)} } }`;
		}
		// No bounds: bound the bucket count instead of the range, so every
		// document still counts and only the resolution gives way (issue #150).
		if (supportsMinimumInterval(interval)) {
			return `${AUTO_DATE_HISTOGRAM_HELPER}(${fieldLit}, ${intervalLit})`;
		}
		// `week`/`quarter` have no `minimum_interval` spelling. Emitting a
		// coarser floor would silently drop resolution the author asked for and
		// a finer one would silently add detail, so keep the declared histogram
		// as-is; the decorator warns that bounds are the only lever here.
		return `{ ${aggType}: { field: ${fieldLit}, calendar_interval: ${intervalLit} } }`;
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

	// Match the dedupe in renderAggSpecLiteral — first-wins on duplicate aggName.
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
	renderAggsAssignment,
	renderAggSpecLiteral,
	renderBuildAggsFunction,
	renderResponseAggregations,
	DEFAULT_MONOLITHIC_THRESHOLD_BYTES,
};
