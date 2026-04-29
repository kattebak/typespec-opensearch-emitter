import { type AggregationEntry, collectAggregations } from "./aggregations.js";
import { toGraphQLQueryFieldName } from "./emit-graphql-sdl.js";
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

	const content = renderResolver(
		projection.indexName,
		textFields,
		keywordFields,
		aggregations,
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
	options: ResolverOptions,
): string {
	const textFieldsLiteral = JSON.stringify(textFields);
	const keywordFieldsLiteral = JSON.stringify(keywordFields);
	const aggsBlock = renderAggsBlock(aggregations);
	const responseAggregations = renderResponseAggregations(aggregations);

	return `import { util } from "@aws-appsync/utils";

export function request(ctx) {
	const args = ctx.args;
	const size = Math.min(args.first || ${options.defaultPageSize}, ${options.maxPageSize});
	const searchAfter = args.after ? JSON.parse(util.base64Decode(args.after)) : undefined;

	const query = buildQuery(args.query, args.filter);

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

function buildQuery(queryText, filter) {
	const musts = [];
	const filters = [];

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

	if (musts.length === 0 && filters.length === 0) {
		return { match_all: {} };
	}

	return {
		bool: {
			...(musts.length > 0 ? { must: musts } : {}),
			...(filters.length > 0 ? { filter: filters } : {}),
		},
	};
}
`;
}

function renderAggsBlock(aggregations: AggregationEntry[]): string {
	if (aggregations.length === 0) {
		return "";
	}

	const lines = aggregations.map((entry) => {
		const aggType = osAggType(entry.kind);
		return `\t\t${entry.aggName}: { ${aggType}: { field: ${JSON.stringify(entry.openSearchField)} } },`;
	});

	return `\n\t\taggs: {\n${lines.join("\n")}\n\t\t},`;
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
	switch (entry.kind) {
		case "terms":
			return `\t\t\t${entry.aggName}: (parsedBody.aggregations?.${entry.aggName}?.buckets ?? []).map((b) => ({ key: b.key, count: b.doc_count })),`;
		case "cardinality":
			return `\t\t\t${entry.aggName}: parsedBody.aggregations?.${entry.aggName}?.value ?? 0,`;
		case "missing":
			return `\t\t\t${entry.aggName}: parsedBody.aggregations?.${entry.aggName}?.doc_count ?? 0,`;
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
