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

	const nestedStructTypes = renderNestedStructTypes(program, projection);
	if (nestedStructTypes) {
		lines.push(nestedStructTypes);
		lines.push("");
	}

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

	const sortTypes = renderSortTypes(projection);
	if (sortTypes) {
		lines.push(sortTypes);
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

/**
 * Emit `type <Name> { ... }` blocks for nested struct models referenced from
 * the response shape (e.g. `Address`, `EmailRecord`). Without these the
 * assembled AppSync schema fails validation because field types are not
 * present.
 *
 * Only walks virtual sub-projections (the field's struct type itself, not an
 * explicit `SearchProjection<T>` instantiation). Explicit projections already
 * emit their own `<Type> { ... }` block via their own SDL file.
 */
function renderNestedStructTypes(
	program: Program,
	projection: ResolvedProjection,
): string | undefined {
	const blocks: string[] = [];
	const seen = new Set<string>();
	collectNestedStructTypes(program, projection, blocks, seen);
	if (blocks.length === 0) return undefined;
	return blocks.join("\n\n");
}

function collectNestedStructTypes(
	program: Program,
	projection: ResolvedProjection,
	out: string[],
	seen: Set<string>,
): void {
	for (const field of projection.fields) {
		if (!field.searchable) continue;
		if (!field.subProjection) continue;
		if (!isVirtualSubProjection(field.subProjection)) continue;
		const sub = field.subProjection;
		const name = sub.projectionModel.name;
		if (seen.has(name)) continue;
		seen.add(name);
		out.push(renderVirtualStructType(program, sub));
		collectNestedStructTypes(program, sub, out, seen);
	}
}

function isVirtualSubProjection(sub: ResolvedProjection): boolean {
	// buildVirtualSubProjection sets projectionModel === sourceModel; explicit
	// SearchProjection<T> instantiations have distinct projection/source models.
	return sub.projectionModel === sub.sourceModel;
}

function renderVirtualStructType(
	program: Program,
	sub: ResolvedProjection,
): string {
	const typeName = sub.projectionModel.name;
	const fieldLines = sub.fields.map((field) => {
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
	// Dedup `<Type>SearchFilter` declarations by typeName (issue #103). The
	// same nested shape can be reachable via multiple paths in the recursion
	// graph; without dedup the SDL ends up with two `input X { ... }` blocks
	// for the same X, which is ill-formed.
	const seen = new Set<string>();
	renderSearchFilterShapeRecursive(program, shape, blocks, seen);
	return blocks.join("\n\n");
}

function renderSearchFilterShapeRecursive(
	program: Program,
	shape: SearchFilterShape,
	out: string[],
	seen: Set<string>,
): void {
	if (seen.has(shape.typeName)) return;
	seen.add(shape.typeName);
	out.push(renderSearchFilterInputBlock(program, shape));
	for (const sub of shape.nestedShapes) {
		renderSearchFilterShapeRecursive(program, sub, out, seen);
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
	if (node.kind === "nested" || node.kind === "object") {
		return `  ${node.inputName}: ${node.nestedTypeName ?? "String"}`;
	}
	if (node.kind === "exists" || node.kind === "nested_exists") {
		return `  ${node.inputName}: Boolean`;
	}
	const gqlType = node.sourceField
		? toGraphQLType(program, node.sourceField.type, node.sourceField, "filter")
		: "String";
	const baseScalar = stripListWrap(gqlType);
	if (node.kind === "terms") {
		return `  ${node.inputName}: [${baseScalar}!]`;
	}
	if (node.kind === "range") {
		// FILTER_SPEC carries one entry per range field; SDL still renders
		// four bound inputs (issue #101).
		return [
			`  ${node.inputName}Gte: ${baseScalar}`,
			`  ${node.inputName}Lte: ${baseScalar}`,
			`  ${node.inputName}Gt: ${baseScalar}`,
			`  ${node.inputName}Lt: ${baseScalar}`,
		].join("\n");
	}
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

function sortTypeBaseName(projectionName: string): string {
	return projectionName.replace(/SearchDoc$/, "");
}

export function sortFieldTypeName(projectionName: string): string {
	return `${sortTypeBaseName(projectionName)}SortField`;
}

export function sortInputTypeName(projectionName: string): string {
	return `${sortTypeBaseName(projectionName)}SortInput`;
}

function renderSortTypes(projection: ResolvedProjection): string | undefined {
	const sortableFields = projection.fields.filter((f) => f.sortable);
	if (sortableFields.length === 0) return undefined;

	const projectionName = projection.projectionModel.name;
	const fieldTypeName = sortFieldTypeName(projectionName);
	const inputTypeName = sortInputTypeName(projectionName);

	const fieldNames = sortableFields.map((f) => f.projectedName ?? f.name);

	const blocks: string[] = [];
	blocks.push(["enum SortDirection {", "  ASC", "  DESC", "}"].join("\n"));
	blocks.push(
		[
			`enum ${fieldTypeName} {`,
			...fieldNames.map((name) => `  ${name}`),
			"}",
		].join("\n"),
	);
	blocks.push(
		[
			`input ${inputTypeName} {`,
			`  field: ${fieldTypeName}!`,
			"  direction: SortDirection!",
			"}",
		].join("\n"),
	);
	return blocks.join("\n\n");
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

	const sharedBucketTypes = new Set<string>();
	const customBucketTypes: string[] = [];

	// Dedupe by aggName — same fieldLine matches the resolver-side dedupe in
	// renderAggsObjectLiteral. Without this, an aggregation declared on a field that
	// the projection emits twice (e.g. via spread) produces a duplicate-field
	// SDL block, which AppSync schema validation rejects.
	const seenAggNames = new Set<string>();
	const fieldLines: string[] = [];
	for (const entry of entries) {
		if (seenAggNames.has(entry.aggName)) continue;
		seenAggNames.add(entry.aggName);
		const gqlType = aggregationGraphQLType(entry, sharedBucketTypes);
		if (entry.kind === "terms" && entry.options) {
			const opts = entry.options as {
				sub?: Record<string, unknown>;
				topHits?: number;
			};
			const sub = opts.sub ?? {};
			const hasSub = Object.keys(sub).length > 0;
			const hasTopHits = typeof opts.topHits === "number" && opts.topHits > 0;
			if (hasSub || hasTopHits) {
				const bucketTypeName = `${capitalizeFirst(entry.aggName)}Bucket`;
				const subLines = Object.keys(sub).map((name) => `  ${name}: Float`);
				const hitsLine = hasTopHits ? [`  hits: [${typeName}!]!`] : [];
				customBucketTypes.push(
					[
						`type ${bucketTypeName} {`,
						"  key: String!",
						"  count: Int!",
						...subLines,
						...hitsLine,
						"}",
					].join("\n"),
				);
				fieldLines.push(`  ${entry.aggName}: [${bucketTypeName}!]!`);
				continue;
			}
		}
		fieldLines.push(`  ${entry.aggName}: ${gqlType}`);
	}

	const sharedBucketBlocks: string[] = [];
	if (sharedBucketTypes.has("TermBucket")) {
		sharedBucketBlocks.push(
			["type TermBucket {", "  key: String!", "  count: Int!", "}"].join("\n"),
		);
	}
	if (sharedBucketTypes.has("DateHistogramBucket")) {
		sharedBucketBlocks.push(
			[
				"type DateHistogramBucket {",
				"  key: String!",
				"  keyAsString: String",
				"  count: Int!",
				"}",
			].join("\n"),
		);
	}
	if (sharedBucketTypes.has("RangeBucket")) {
		sharedBucketBlocks.push(
			[
				"type RangeBucket {",
				"  key: String!",
				"  from: Float",
				"  to: Float",
				"  count: Int!",
				"}",
			].join("\n"),
		);
	}

	const lines = [
		...sharedBucketBlocks,
		...customBucketTypes,
		`type ${aggregationsType} {`,
		...fieldLines,
		"}",
	];

	return lines.join("\n\n").replace(/\n\ntype /g, "\n\ntype ");
}

function aggregationGraphQLType(
	entry: AggregationEntry,
	sharedBucketTypes: Set<string>,
): string {
	switch (entry.kind) {
		case "terms":
			sharedBucketTypes.add("TermBucket");
			return "[TermBucket!]!";
		case "date_histogram":
			sharedBucketTypes.add("DateHistogramBucket");
			return "[DateHistogramBucket!]!";
		case "range":
			sharedBucketTypes.add("RangeBucket");
			return "[RangeBucket!]!";
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

function capitalizeFirst(name: string): string {
	if (name.length === 0) return name;
	return name[0].toUpperCase() + name.slice(1);
}

type EmitContext = "response" | "filter";

function toGraphQLType(
	program: Program,
	type: Type,
	field?: ResolvedProjectionField,
	context: EmitContext = "response",
): string {
	if (field?.subProjection) {
		const subName = field.subProjection.projectionModel.name;
		const isArray =
			type.kind === "Model" && type.name === "Array" && !!type.indexer?.value;
		return isArray ? `[${subName}!]` : subName;
	}

	switch (type.kind) {
		case "Scalar":
			return scalarToGraphQL(type, context);
		case "Model":
			return modelToGraphQL(program, type, context);
		case "String":
			return "String";
		case "Number":
			return "Float";
		case "Boolean":
			return "Boolean";
		case "Union":
			return unionToGraphQL(program, type, context);
		case "Enum":
			return "String";
		default:
			return "String";
	}
}

function scalarToGraphQL(scalar: Scalar, context: EmitContext): string {
	let current: Scalar | undefined = scalar;
	while (current) {
		switch (current.name) {
			case "string":
			case "plainDate":
			case "utcDateTime":
				return "String";
			case "int64":
			case "uint64":
				// AppSync GraphQL has no Long scalar; Int is 32-bit (max ~2.1B) so
				// realistic int64 values (e.g. epoch-ms timestamps ~1.7T) overflow at
				// parse time on filter inputs. Emit String for filter inputs so callers
				// can serialize the 64-bit value as a numeric string. Response types
				// keep Int for backward compatibility (a separate concern, since the
				// resolver-side serialization path is already constrained by AppSync).
				return context === "filter" ? "String" : "Int";
			case "int32":
			case "integer":
			case "safeint":
			case "uint8":
			case "uint16":
			case "uint32":
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

function modelToGraphQL(
	program: Program,
	model: Model,
	context: EmitContext,
): string {
	if (model.name === "Array" && model.indexer?.value) {
		const elementType = toGraphQLType(
			program,
			model.indexer.value,
			undefined,
			context,
		);
		return `[${elementType}!]`;
	}

	return "String";
}

function unionToGraphQL(
	program: Program,
	union: Union,
	context: EmitContext,
): string {
	for (const variant of union.variants.values()) {
		if (variant.type.kind === "Scalar" || variant.type.kind === "String") {
			return toGraphQLType(program, variant.type, undefined, context);
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
