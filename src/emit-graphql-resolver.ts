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

export function emitGraphQLResolver(
	projection: ResolvedProjection,
	options: ResolverOptions,
): EmittedResolverFile {
	const typeName = projection.projectionModel.name;
	const queryFieldName = toGraphQLQueryFieldName(typeName);
	const fileName = `${toKebabCase(typeName)}-resolver.js`;

	const textFields = projection.fields
		.filter(
			(f) => !f.keyword && !f.nested && !f.subProjection && hasTextType(f),
		)
		.map((f) => f.projectedName ?? f.name);

	const keywordFields = projection.fields
		.filter((f) => f.keyword)
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

	const stack = [
		{
			kind: "process",
			spec: rootSpec,
			input: rootInput,
			outFilters: rootOutFilters,
			outMustNots: rootOutMustNots,
		},
	];

	while (stack.length > 0) {
		const work = stack.pop();

		if (work.kind === "finalize") {
			for (const clause of work.childFilters) {
				work.parentFilters.push({
					nested: {
						path: work.path,
						query: { bool: { filter: [clause] } },
					},
				});
			}
			for (const clause of work.childMustNots) {
				work.parentMustNots.push({
					nested: {
						path: work.path,
						query: { bool: { filter: [clause] } },
					},
				});
			}
			continue;
		}

		const spec = work.spec;
		const input = work.input;
		const outFilters = work.outFilters;
		const outMustNots = work.outMustNots;
		const rangeBuckets = {};

		for (const node of spec) {
			const value = input[node.inputName];
			if (node.kind === "nested") {
				if (value == null) continue;
				const childFilters = [];
				const childMustNots = [];
				stack.push({
					kind: "finalize",
					path: node.path,
					childFilters,
					childMustNots,
					parentFilters: outFilters,
					parentMustNots: outMustNots,
				});
				stack.push({
					kind: "process",
					spec: node.children,
					input: value,
					outFilters: childFilters,
					outMustNots: childMustNots,
				});
				continue;
			}
			if (node.kind === "term") {
				if (value == null) continue;
				outFilters.push({ term: { [node.field]: value } });
				continue;
			}
			if (node.kind === "term_negate") {
				if (value == null) continue;
				outMustNots.push({ term: { [node.field]: value } });
				continue;
			}
			if (node.kind === "exists") {
				if (value == null) continue;
				if (value === true) {
					outFilters.push({ exists: { field: node.field } });
				} else {
					outMustNots.push({ exists: { field: node.field } });
				}
				continue;
			}
			if (node.kind === "range") {
				if (value == null) continue;
				const bucket = (rangeBuckets[node.field] = rangeBuckets[node.field] || {});
				bucket[node.bound] = value;
				continue;
			}
		}

		for (const field in rangeBuckets) {
			outFilters.push({ range: { [field]: rangeBuckets[field] } });
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
	}
}

export const __test = {
	hasTextType,
	renderResolver,
	renderAggsBlock,
	renderResponseAggregations,
};
