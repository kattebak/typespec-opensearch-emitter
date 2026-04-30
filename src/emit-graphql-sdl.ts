import type { Model, Program, Scalar, Type, Union } from "@typespec/compiler";
import {
	type AggregationEntry,
	aggregationsTypeName,
	collectAggregations,
	hasAggregations,
} from "./aggregations.js";
import { getSearchAs, isSearchable } from "./decorators.js";
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

	const searchFilterShape = buildSearchFilterShape(projection);
	if (searchFilterShape) {
		lines.push(renderSearchFilterInputs(program, searchFilterShape));
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
	// Filter-only / aggregatable-only fields exist in the OpenSearch index for
	// query-time use but are not part of the user-facing response shape.
	const fieldLines = projection.fields
		.filter((field) => field.searchable)
		.map((field) => {
			const gqlName = field.projectedName ?? field.name;
			const gqlType = toGraphQLType(program, field.type, field);
			const nullable = field.optional ? "" : "!";
			return `  ${gqlName}: ${gqlType}${nullable}`;
		});

	return `type ${typeName} {\n${fieldLines.join("\n")}\n}`;
}

function renderFilterInput(projection: ResolvedProjection): string | undefined {
	const typeName = projection.projectionModel.name;
	const keywordFields = projection.fields.filter(
		(f) => f.searchable && f.keyword,
	);

	if (keywordFields.length === 0) {
		return undefined;
	}

	const fieldLines = keywordFields.map((field) => {
		const gqlName = field.projectedName ?? field.name;
		return `  ${gqlName}: String`;
	});

	return `input ${typeName}Filter {\n${fieldLines.join("\n")}\n}`;
}

function renderSearchFilterInputs(
	program: Program,
	shape: SearchFilterShape,
): string {
	const blocks: string[] = [];
	renderSearchFilterShapeRecursive(program, shape, blocks);
	return blocks.join("\n\n");
}

function renderSearchFilterShapeRecursive(
	program: Program,
	shape: SearchFilterShape,
	out: string[],
): void {
	out.push(renderSearchFilterInputBlock(program, shape));
	for (const sub of shape.nestedShapes) {
		renderSearchFilterShapeRecursive(program, sub, out);
	}
}

function renderSearchFilterInputBlock(
	program: Program,
	shape: SearchFilterShape,
): string {
	const fieldLines = shape.nodes.map((node) =>
		renderSearchFilterField(program, node),
	);
	return `input ${shape.typeName} {\n${fieldLines.join("\n")}\n}`;
}

function renderSearchFilterField(
	program: Program,
	node: FilterSpecNode,
): string {
	if (node.kind === "nested") {
		return `  ${node.inputName}: ${node.nestedTypeName ?? "String"}`;
	}
	if (node.kind === "exists" || node.kind === "nested_exists") {
		return `  ${node.inputName}: Boolean`;
	}
	const gqlType = node.sourceField
		? toGraphQLType(program, node.sourceField.type, node.sourceField)
		: "String";
	const baseScalar = stripListWrap(gqlType);
	return `  ${node.inputName}: ${baseScalar}`;
}

/**
 * For input filter scalars we drop list-of-X wrapping: a filter like
 * `tags: String` matches against any element of the array under the hood,
 * and `[String]!` would be misleading on an input type.
 */
function stripListWrap(gqlType: string): string {
	const m = gqlType.match(/^\[(.+?)!?\]!?$/);
	if (m) {
		return m[1];
	}
	return gqlType;
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
		const gqlType = aggregationGraphQLType(entry.kind);
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

function aggregationGraphQLType(kind: AggregationEntry["kind"]): string {
	switch (kind) {
		case "terms":
			return "[TermBucket!]!";
		case "cardinality":
		case "missing":
			return "Int!";
		case "sum":
		case "avg":
		case "min":
		case "max":
			// Nullable: OpenSearch returns null when no documents match the agg.
			return "Float";
	}
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
