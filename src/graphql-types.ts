import type { Model, Program, Scalar, Type, Union } from "@typespec/compiler";
import type { ResolvedProjectionField } from "./projection.js";

/**
 * Shared TypeSpec-type → GraphQL-type mapping, extracted verbatim from
 * emit-graphql-sdl.ts (issue #134) so the REST SDL emitter reuses the exact
 * same scalar/model mapping without touching the OpenSearch search path.
 */

export type GraphQLEmitContext = "response" | "filter" | "rest";

export function toGraphQLType(
	program: Program,
	type: Type,
	field?: ResolvedProjectionField,
	context: GraphQLEmitContext = "response",
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

function scalarToGraphQL(scalar: Scalar, context: GraphQLEmitContext): string {
	let current: Scalar | undefined = scalar;
	while (current) {
		switch (current.name) {
			case "string":
			case "plainDate":
			case "utcDateTime":
			case "offsetDateTime":
				return "String";
			case "int64":
			case "uint64":
				// AppSync GraphQL has no Long scalar and its Int is 32-bit (max ~2.1B),
				// so realistic values (epoch-ms ~1.7T) overflow. Response and rest map to
				// Float: AppSync rejects values > 2^31-1 during response coercion (nulling
				// the whole query response), and Float (IEEE double) is exact to 2^53.
				// Filter maps to String because 64-bit values can exceed 2^53.
				return context === "filter" ? "String" : "Float";
			case "safeint":
				// safeint spans up to 2^53, overflowing GraphQL's 32-bit Int. Response and
				// rest map to Float (exact to 2^53); AppSync coerces the response otherwise.
				return context === "filter" ? "Int" : "Float";
			case "int32":
			case "integer":
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
	context: GraphQLEmitContext,
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
	context: GraphQLEmitContext,
): string {
	for (const variant of union.variants.values()) {
		if (variant.type.kind === "Scalar" || variant.type.kind === "String") {
			return toGraphQLType(program, variant.type, undefined, context);
		}
	}
	return "String";
}
