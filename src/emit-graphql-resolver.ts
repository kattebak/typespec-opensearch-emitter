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

				// FILTER_SPEC nodes use compact keys to fit under AppSync's 32 KB
				// resolver code cap (issue #99): i=inputName, k=kind, f=field,
				// p=path, c=children. See stringifyNode in the emitter. Range
				// kind carries one entry per field; the resolver expands the
				// four bound inputs (i+"Gte"/Lte/Gt/Lt) at iteration time
				// (issue #101).
				for (const node of spec) {
					const value = input[node.i];
					if (node.k === "nested") {
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
								spec: node.c,
								input: value,
								outFilters: childFilters,
								outMustNots: childMustNots,
							};
							tail = tail + 1;
							slots[tail] = {
								kind: "finalize",
								path: node.p,
								childFilters,
								childMustNots,
								parentFilters: outFilters,
								parentMustNots: outMustNots,
							};
							tail = tail + 1;
						}
					} else if (node.k === "object") {
						if (value != null) {
							if (tail + 1 > slots.length) {
								util.error(
									"applyFilterSpec exceeded fixed work-slot capacity; SearchFilter shape too deep for APPSYNC_JS resolver",
								);
							}
							slots[tail] = {
								kind: "process",
								spec: node.c,
								input: value,
								outFilters,
								outMustNots,
							};
							tail = tail + 1;
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
	// FILTER_SPEC entries use single-letter keys to keep wide projections
	// under AppSync's 32 KB resolver-code cap (issue #99). The reader is
	// applyFilterSpec inside the emitted resolver; keys must match there:
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

	const lines = aggregations.map((entry) => renderAggLine(entry));

	return `\n\t\taggs: {\n${lines.join("\n")}\n\t\t},`;
}

function renderAggLine(entry: AggregationEntry): string {
	const inner = renderAggInner(entry);
	if (entry.nestedPath) {
		return `\t\t${entry.aggName}: { nested: { path: ${JSON.stringify(entry.nestedPath)} }, aggs: { ${NESTED_INNER_AGG_NAME}: ${inner} } },`;
	}
	return `\t\t${entry.aggName}: ${inner},`;
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
	renderAggsBlock,
	renderResponseAggregations,
};
