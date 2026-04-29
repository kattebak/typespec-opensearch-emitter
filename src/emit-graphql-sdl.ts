import type { Model, Program, Scalar, Type, Union } from "@typespec/compiler";
import {
	type AggregationEntry,
	aggregationsTypeName,
	collectAggregations,
	hasAggregations,
} from "./aggregations.js";
import { getSearchAs, isSearchable } from "./decorators.js";
import type {
	ResolvedProjection,
	ResolvedProjectionField,
} from "./projection.js";
import { toKebabCase } from "./utils.js";

export interface EmittedGraphQLFile {
	fileName: string;
	content: string;
}

export interface GraphQLOptions {
	defaultPageSize: number;
	maxPageSize: number;
}

export function emitGraphQLSdl(
	program: Program,
	projection: ResolvedProjection,
	options: GraphQLOptions,
): EmittedGraphQLFile {
	const typeName = projection.projectionModel.name;
	const fileName = `${toKebabCase(typeName)}.graphql`;

	const lines: string[] = [];

	lines.push(renderObjectType(program, projection));
	lines.push("");

	const filterType = renderFilterInput(projection);
	if (filterType) {
		lines.push(filterType);
		lines.push("");
	}

	const aggEntries = collectAggregations(projection);
	if (aggEntries.length > 0) {
		lines.push(renderAggregationTypes(typeName, aggEntries));
		lines.push("");
	}

	lines.push(renderConnectionTypes(typeName, hasAggregations(projection)));

	return {
		fileName,
		content: `${lines.join("\n")}\n`,
	};
}

function renderObjectType(
	program: Program,
	projection: ResolvedProjection,
): string {
	const typeName = projection.projectionModel.name;
	const fieldLines = projection.fields.map((field) => {
		const gqlName = field.projectedName ?? field.name;
		const gqlType = toGraphQLType(program, field.type, field);
		const nullable = field.optional ? "" : "!";
		return `  ${gqlName}: ${gqlType}${nullable}`;
	});

	return `type ${typeName} {\n${fieldLines.join("\n")}\n}`;
}

function renderFilterInput(projection: ResolvedProjection): string | undefined {
	const typeName = projection.projectionModel.name;
	const keywordFields = projection.fields.filter((f) => f.keyword);

	if (keywordFields.length === 0) {
		return undefined;
	}

	const fieldLines = keywordFields.map((field) => {
		const gqlName = field.projectedName ?? field.name;
		return `  ${gqlName}: String`;
	});

	return `input ${typeName}Filter {\n${fieldLines.join("\n")}\n}`;
}

function renderConnectionTypes(
	typeName: string,
	includeAggregations: boolean,
): string {
	const aggregationsTypeReference = includeAggregations
		? `  aggregations: ${aggregationsTypeName(typeName)}!`
		: undefined;

	const connectionFields = [
		`  edges: [${typeName}Edge!]!`,
		"  totalCount: Int!",
		...(aggregationsTypeReference ? [aggregationsTypeReference] : []),
		"  pageInfo: PageInfo!",
	];

	const lines = [
		`type ${typeName}Connection {`,
		...connectionFields,
		"}",
		"",
		`type ${typeName}Edge {`,
		`  node: ${typeName}!`,
		"  cursor: String!",
		"}",
		"",
		"type PageInfo {",
		"  hasNextPage: Boolean!",
		"  endCursor: String",
		"}",
	];

	return lines.join("\n");
}

function renderAggregationTypes(
	typeName: string,
	entries: AggregationEntry[],
): string {
	const aggregationsType = aggregationsTypeName(typeName);
	const fieldLines = entries.map((entry) => {
		const gqlType = entry.kind === "terms" ? "[TermBucket!]!" : "Int!";
		return `  ${entry.aggName}: ${gqlType}`;
	});

	const lines = [
		"type TermBucket {",
		"  key: String!",
		"  count: Int!",
		"}",
		"",
		`type ${aggregationsType} {`,
		...fieldLines,
		"}",
	];

	return lines.join("\n");
}

function toGraphQLType(
	program: Program,
	type: Type,
	field?: ResolvedProjectionField,
): string {
	if (field?.subProjection) {
		const subName = field.subProjection.projectionModel.name;
		const isArray =
			type.kind === "Model" && type.name === "Array" && !!type.indexer?.value;
		return isArray ? `[${subName}!]` : subName;
	}

	switch (type.kind) {
		case "Scalar":
			return scalarToGraphQL(type);
		case "Model":
			return modelToGraphQL(program, type);
		case "String":
			return "String";
		case "Number":
			return "Float";
		case "Boolean":
			return "Boolean";
		case "Union":
			return unionToGraphQL(program, type);
		case "Enum":
			return "String";
		default:
			return "String";
	}
}

function scalarToGraphQL(scalar: Scalar): string {
	let current: Scalar | undefined = scalar;
	while (current) {
		switch (current.name) {
			case "string":
			case "plainDate":
			case "utcDateTime":
				return "String";
			case "int32":
			case "int64":
			case "integer":
			case "safeint":
			case "uint8":
			case "uint16":
			case "uint32":
			case "uint64":
			case "int8":
			case "int16":
				return "Int";
			case "float":
			case "float32":
			case "float64":
			case "decimal":
			case "numeric":
			case "number":
				return "Float";
			case "boolean":
				return "Boolean";
		}
		current = current.baseScalar;
	}

	return "String";
}

function modelToGraphQL(program: Program, model: Model): string {
	if (model.name === "Array" && model.indexer?.value) {
		const elementType = toGraphQLType(program, model.indexer.value);
		return `[${elementType}!]`;
	}

	return "String";
}

function unionToGraphQL(program: Program, union: Union): string {
	for (const variant of union.variants.values()) {
		if (variant.type.kind === "Scalar" || variant.type.kind === "String") {
			return toGraphQLType(program, variant.type);
		}
	}
	return "String";
}

export function toGraphQLQueryFieldName(projectionModelName: string): string {
	const name = projectionModelName.replace(/SearchDoc$/, "");
	return `search${name}`;
}

export const __test = {
	renderObjectType,
	renderFilterInput,
	renderConnectionTypes,
	renderAggregationTypes,
	toGraphQLType,
	toGraphQLQueryFieldName,
};
