import type { Model, Program, Scalar, Type, Union } from "@typespec/compiler";
import { isSearchable } from "./decorators.js";
import type { ResolvedProjection } from "./projection.js";
import { toKebabCase } from "./utils.js";

export interface EmittedDocTypeFile {
	fileName: string;
	content: string;
}

export function emitDocType(
	program: Program,
	projection: ResolvedProjection,
): EmittedDocTypeFile {
	const fileName = toDocTypeFileName(projection.projectionModel.name);
	const body = renderInterfaceBody(
		program,
		projection.fields.map((x) => ({
			name: x.name,
			type: x.type,
			optional: x.optional,
		})),
	);

	return {
		fileName,
		content: `export interface ${projection.projectionModel.name} ${body}\n`,
	};
}

function renderInterfaceBody(
	program: Program,
	fields: ReadonlyArray<{ name: string; type: Type; optional: boolean }>,
): string {
	if (fields.length === 0) {
		return "{}";
	}

	const lines = fields.map((field) => {
		const optional = field.optional ? "?" : "";
		const type = renderType(program, field.type);
		return `\t${field.name}${optional}: ${type};`;
	});

	return `\n{\n${lines.join("\n")}\n}`;
}

function renderType(program: Program, type: Type): string {
	switch (type.kind) {
		case "Scalar":
			return renderScalar(type);
		case "Model":
			return renderModel(program, type);
		case "String":
			return "string";
		case "Number":
			return "number";
		case "Boolean":
			return "boolean";
		case "Union":
			return renderUnion(program, type);
		default:
			return "unknown";
	}
}

function renderScalar(scalar: Scalar): string {
	let base = scalar;
	while (base.baseScalar) {
		base = base.baseScalar;
	}

	switch (base.name) {
		case "string":
		case "plainDate":
		case "utcDateTime":
			return "string";
		case "int32":
		case "int64":
		case "float":
		case "float32":
		case "float64":
		case "decimal":
		case "numeric":
		case "integer":
		case "safeint":
		case "uint8":
		case "uint16":
		case "uint32":
		case "uint64":
		case "int8":
		case "int16":
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		default:
			return "unknown";
	}
}

function renderModel(program: Program, model: Model): string {
	if (model.name === "Array" && model.indexer?.value) {
		return `${renderType(program, model.indexer.value)}[]`;
	}

	if (model.name === "Record" && model.indexer?.value) {
		return `Record<string, ${renderType(program, model.indexer.value)}>`;
	}

	const searchableFields = Array.from(model.properties.values())
		.filter((prop) => isSearchable(program, prop))
		.map((prop) => ({
			name: prop.name,
			type: prop.type,
			optional: prop.optional,
		}));

	if (searchableFields.length === 0) {
		return "{}";
	}

	const lines = searchableFields.map((field) => {
		const optional = field.optional ? "?" : "";
		return `\t${field.name}${optional}: ${renderType(program, field.type)};`;
	});

	return `{\n${lines.join("\n")}\n}`;
}

function renderUnion(program: Program, union: Union): string {
	const variants = Array.from(union.variants.values());
	if (variants.length === 0) {
		return "never";
	}

	return variants.map((x) => renderType(program, x.type)).join(" | ");
}

export function toDocTypeFileName(projectionModelName: string): string {
	const kebab = toKebabCase(projectionModelName);
	const base = kebab.endsWith("-search-doc")
		? kebab.slice(0, -"-search-doc".length)
		: kebab;
	return `${base}-search-doc.ts`;
}

export const __test = {
	renderModel,
	renderScalar,
	renderType,
	renderUnion,
	toDocTypeFileName,
	toKebabCase,
};
