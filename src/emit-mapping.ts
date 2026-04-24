import type { Model, Program, Scalar, Type, Union } from "@typespec/compiler";
import {
	getAnalyzer,
	getBoost,
	isKeyword,
	isNested,
	isSearchable,
} from "./decorators.js";
import type { ResolvedProjection } from "./projection.js";
import { toKebabCase } from "./utils.js";

export interface EmittedMappingFile {
	fileName: string;
	content: string;
}

type MappingProperty = Record<string, unknown>;

export function emitMapping(
	program: Program,
	projection: ResolvedProjection,
): EmittedMappingFile {
	const fileName = `${toKebabCase(projection.projectionModel.name)}-search-mapping.json`;
	const properties = Object.fromEntries(
		projection.fields.map((field) => [
			field.name,
			toMapping(program, field.type, {
				keyword: field.keyword,
				nested: field.nested,
				analyzer: field.analyzer,
				boost: field.boost,
			}),
		]),
	);

	return {
		fileName,
		content: `${JSON.stringify({ mappings: { properties } }, null, 2)}\n`,
	};
}

function toMapping(
	program: Program,
	type: Type,
	override?: {
		keyword?: boolean;
		nested?: boolean;
		analyzer?: string;
		boost?: number;
	},
): MappingProperty {
	switch (type.kind) {
		case "Scalar":
			return mapScalar(type, override);
		case "Model":
			return mapModel(program, type, override);
		case "String":
			return mapString(override);
		case "Number":
			return { type: "double" };
		case "Boolean":
			return { type: "boolean" };
		case "Union":
			return mapUnion(program, type, override);
		case "Enum":
			return { type: "keyword" };
		default:
			return { type: "object" };
	}
}

function mapString(override?: {
	keyword?: boolean;
	analyzer?: string;
	boost?: number;
}): MappingProperty {
	if (override?.keyword) {
		return { type: "keyword" };
	}

	const mapping: MappingProperty = {
		type: "text",
		fields: {
			keyword: {
				type: "keyword",
				ignore_above: 256,
			},
		},
	};

	if (override?.analyzer) {
		mapping.analyzer = override.analyzer;
	}
	if (override?.boost !== undefined) {
		mapping.boost = override.boost;
	}

	return mapping;
}

function mapScalar(
	scalar: Scalar,
	override?: { keyword?: boolean; analyzer?: string; boost?: number },
): MappingProperty {
	let current: Scalar | undefined = scalar;
	while (current) {
		switch (current.name) {
			case "string":
				return mapString(override);
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
				return { type: "long" };
			case "float":
			case "float32":
			case "float64":
			case "decimal":
			case "numeric":
			case "number":
				return { type: "double" };
			case "boolean":
				return { type: "boolean" };
			case "utcDateTime":
			case "plainDate":
				return { type: "date" };
		}
		current = current.baseScalar;
	}

	return { type: "object" };
}

function mapModel(
	program: Program,
	model: Model,
	override?: { nested?: boolean },
): MappingProperty {
	if (model.name === "Array" && model.indexer?.value) {
		const elementType = model.indexer.value;
		if (elementType.kind === "Model") {
			return {
				type: override?.nested ? "nested" : "object",
				properties: mapModelProperties(program, elementType),
			};
		}
		return toMapping(program, elementType);
	}

	return {
		type: "object",
		properties: mapModelProperties(program, model),
	};
}

function mapModelProperties(
	program: Program,
	model: Model,
): Record<string, MappingProperty> {
	return Object.fromEntries(
		Array.from(model.properties.values())
			.filter((prop) => isSearchable(program, prop))
			.map((prop) => [
				prop.name,
				toMapping(program, prop.type, {
					keyword: isKeyword(program, prop),
					nested: isNested(program, prop),
					analyzer: getAnalyzer(program, prop),
					boost: getBoost(program, prop),
				}),
			]),
	);
}

function mapUnion(
	program: Program,
	union: Union,
	override?: { keyword?: boolean; analyzer?: string; boost?: number },
): MappingProperty {
	for (const variant of union.variants.values()) {
		if (variant.type.kind === "Scalar" || variant.type.kind === "String") {
			return toMapping(program, variant.type, override);
		}
	}
	return { type: "object" };
}

export const __test = {
	mapModel,
	mapScalar,
	mapString,
	mapUnion,
	toKebabCase,
	toMapping,
};
