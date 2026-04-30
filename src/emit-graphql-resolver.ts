import {
	type AggregationEntry,
	collectAggregations,
	NESTED_INNER_AGG_NAME,
} from "./aggregations.js";
import { toGraphQLQueryFieldName } from "./emit-graphql-sdl.js";
import {
	buildSearchFilterShape,
	type FilterSpecNode,
	type SearchFilterShape,
} from "./filters.js";
import type {
	ResolvedProjection,
	ResolvedProjectionField,
} from "./projection.js";
import { toKebabCase } from "./utils.js";

export interface EmittedResolverFile {
	fileName: string;
	content: string;
	queryFieldName: string;
}

export interface ResolverOptions {
	defaultPageSize: number;
	maxPageSize: number;
	trackTotalHitsUpTo: number;
}

// Bound for the runtime applyFilterSpec walker's fixed-size work slot pool.
// APPSYNC_JS does not honor self-extending Array iteration, so the emitted
// resolver pre-allocates this many slots as a literal. Set well above any
// realistic SearchFilter shape; runtime util.error fires if exceeded.
const FILTER_WORK_SLOT_COUNT = 256;

export function emitGraphQLResolver(
	projection: ResolvedProjection,
	options: ResolverOptions,
): EmittedResolverFile {
	const typeName = projection.projectionModel.name;
	const queryFieldName = toGraphQLQueryFieldName(typeName);
	const fileName = `${toKebabCase(typeName)}-resolver.js`;

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

	const content = renderResolver(
		projection.indexName,
		textFields,
		keywordFields,
		aggregations,
		searchFilterShape,
		options,
	);

	return {
		fileName,
		content,
		queryFieldName,
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

function renderResolver(
	indexName: string,
	textFields: string[],
	keywordFields: string[],
	aggregations: AggregationEntry[],
	searchFilterShape: SearchFilterShape | undefined,
	options: ResolverOptions,
): string {
	const textFieldsLiteral = JSON.stringify(textFields);
	const keywordFieldsLiteral = JSON.stringify(keywordFields);
	const aggsBlock = renderAggsBlock(aggregations);
	const responseAggregations = renderResponseAggregations(aggregations);
	const filterSpecLiteral = renderFilterSpecLiteral(searchFilterShape);
	const slotsLiteral = `[${"undefined,".repeat(FILTER_WORK_SLOT_COUNT).slice(0, -1)}]`;

	return `import { util } from "@aws-appsync/utils";

const FILTER_SPEC = ${filterSpecLiteral};

export function request(ctx) {
	const args = ctx.args;
	const size = Math.min(args.first || ${options.defaultPageSize}, ${options.maxPageSize});
	const searchAfter = args.after ? JSON.parse(util.base64Decode(args.after)) : undefined;

	const query = buildQuery(args.query, args.filter, args.searchFilter);

	const body = {
		size: size + 1,
		track_total_hits: ${options.trackTotalHitsUpTo},
		sort: [{ _score: "desc" }, { _id: "asc" }],
		query,${aggsBlock}
	};

	if (searchAfter) {
		body.search_after = searchAfter;
	}

	return {
		operation: "GET",
		path: \`/${indexName}/_search\`,
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

function applyFilterSpec(rootSpec, rootInput, rootOutFilters, rootOutMustNots) {
	if (!rootSpec || !rootInput) return;

	// APPSYNC_JS forbids while, continue, C-style for(init;cond;update), and
	// the increment/decrement unary operators (lint rules @aws-appsync/no-while,
	// @aws-appsync/no-continue, @aws-appsync/no-for,
	// @aws-appsync/no-disallowed-unary-operators). It also does not honor the
	// ECMA spec for Array's @@iterator: items pushed during \`for...of\`
	// iteration are NOT visited (verified via aws appsync evaluate-code). We
	// drive iteration with a fixed-length slot pool and a FIFO head/tail
	// index pair: the \`for...of\` runs exactly slots.length times (its
	// bound), and the body checks head < tail to act on real work. FIFO
	// ordering is fine because filter semantics are conjunctive. Each
	// "nested" node enqueues a "process" item then a "finalize" item; the
	// child's clauses are populated before finalize wraps them onto the
	// parent. The slot count is set well above any realistic SearchFilter
	// shape; exceeding it raises util.error at runtime.
	const slots = ${slotsLiteral};
	slots[0] = {
		kind: "process",
		spec: rootSpec,
		input: rootInput,
		outFilters: rootOutFilters,
		outMustNots: rootOutMustNots,
	};
	let head = 0;
	let tail = 1;

	for (const _slot of slots) {
		if (head < tail) {
			const item = slots[head];
			head = head + 1;
			if (item.kind === "finalize") {
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
			} else {
				const spec = item.spec;
				const input = item.input;
				const outFilters = item.outFilters;
				const outMustNots = item.outMustNots;
				const rangeBuckets = {};

				for (const node of spec) {
					const value = input[node.inputName];
					if (node.kind === "nested") {
						if (value != null) {
							const childFilters = [];
							const childMustNots = [];
							if (tail + 2 > slots.length) {
								util.error(
									"applyFilterSpec exceeded fixed work-slot capacity; SearchFilter shape too deep for APPSYNC_JS resolver",
								);
							}
							slots[tail] = {
								kind: "process",
								spec: node.children,
								input: value,
								outFilters: childFilters,
								outMustNots: childMustNots,
							};
							tail = tail + 1;
							slots[tail] = {
								kind: "finalize",
								path: node.path,
								childFilters,
								childMustNots,
								parentFilters: outFilters,
								parentMustNots: outMustNots,
							};
							tail = tail + 1;
						}
					} else if (node.kind === "term") {
						if (value != null) {
							outFilters.push({ term: { [node.field]: value } });
						}
					} else if (node.kind === "term_negate") {
						if (value != null) {
							outMustNots.push({ term: { [node.field]: value } });
						}
					} else if (node.kind === "exists") {
						if (value != null) {
							if (value === true) {
								outFilters.push({ exists: { field: node.field } });
							} else {
								outMustNots.push({ exists: { field: node.field } });
							}
						}
					} else if (node.kind === "nested_exists") {
						if (value != null) {
							const nestedClause = {
								nested: { path: node.path, query: { match_all: {} } },
							};
							if (value === true) {
								outFilters.push(nestedClause);
							} else {
								outMustNots.push(nestedClause);
							}
						}
					} else if (node.kind === "range") {
						if (value != null) {
							const bucket = (rangeBuckets[node.field] = rangeBuckets[node.field] || {});
							bucket[node.bound] = value;
						}
					}
				}

				for (const field in rangeBuckets) {
					outFilters.push({ range: { [field]: rangeBuckets[field] } });
				}
			}
		}
	}
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
	if (node.kind === "nested") {
		const children = stringifySpec(node.children ?? []);
		return `{ inputName: ${JSON.stringify(node.inputName)}, kind: "nested", path: ${JSON.stringify(node.path ?? "")}, children: ${children} }`;
	}
	if (node.kind === "nested_exists") {
		return `{ inputName: ${JSON.stringify(node.inputName)}, kind: "nested_exists", path: ${JSON.stringify(node.path ?? "")} }`;
	}
	if (node.kind === "range") {
		return `{ inputName: ${JSON.stringify(node.inputName)}, kind: "range", field: ${JSON.stringify(node.field ?? "")}, bound: ${JSON.stringify(node.bound ?? "")} }`;
	}
	return `{ inputName: ${JSON.stringify(node.inputName)}, kind: ${JSON.stringify(node.kind)}, field: ${JSON.stringify(node.field ?? "")} }`;
}

function renderAggsBlock(aggregations: AggregationEntry[]): string {
	if (aggregations.length === 0) {
		return "";
	}

	const lines = aggregations.map((entry) => renderAggLine(entry));

	return `\n\t\taggs: {\n${lines.join("\n")}\n\t\t},`;
}

function renderAggLine(entry: AggregationEntry): string {
	const aggType = osAggType(entry.kind);
	const inner = `{ ${aggType}: { field: ${JSON.stringify(entry.openSearchField)} } }`;
	if (entry.nestedPath) {
		return `\t\t${entry.aggName}: { nested: { path: ${JSON.stringify(entry.nestedPath)} }, aggs: { ${NESTED_INNER_AGG_NAME}: ${inner} } },`;
	}
	return `\t\t${entry.aggName}: ${inner},`;
}

function renderResponseAggregations(aggregations: AggregationEntry[]): string {
	if (aggregations.length === 0) {
		return "";
	}

	const lines = aggregations.map((entry) =>
		renderResponseAggregationLine(entry),
	);

	return `\n\t\taggregations: {\n${lines.join("\n")}\n\t\t},`;
}

function renderResponseAggregationLine(entry: AggregationEntry): string {
	const path = entry.nestedPath
		? `parsedBody.aggregations?.${entry.aggName}?.${NESTED_INNER_AGG_NAME}`
		: `parsedBody.aggregations?.${entry.aggName}`;
	switch (entry.kind) {
		case "terms":
			return `\t\t\t${entry.aggName}: (${path}?.buckets ?? []).map((b) => ({ key: b.key, count: b.doc_count })),`;
		case "cardinality":
			return `\t\t\t${entry.aggName}: ${path}?.value ?? 0,`;
		case "missing":
			return `\t\t\t${entry.aggName}: ${path}?.doc_count ?? 0,`;
		case "sum":
		case "avg":
		case "min":
		case "max":
			return `\t\t\t${entry.aggName}: ${path}?.value ?? null,`;
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
	renderAggsBlock,
	renderResponseAggregations,
};
