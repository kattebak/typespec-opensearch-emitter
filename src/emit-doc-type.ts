import type {
	Enum,
	Model,
	Program,
	Scalar,
	Type,
	Union,
} from "@typespec/compiler";
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
	const body = renderBlock(
		program,
		projection.fields.map((x) => ({
			name: x.projectedName ?? x.name,
			type: x.type,
			optional: x.optional,
		})),
		1,
	);

	return {
		fileName,
		content: `export interface ${projection.projectionModel.name} ${body}\n`,
	};
}

/**
 * Render a `{ ... }` block with fields indented at `depth`.
 * `depth` always means "indent level of the fields inside this block".
 */
function renderBlock(
	program: Program,
	fields: ReadonlyArray<{ name: string; type: Type; optional: boolean }>,
	depth: number,
): string {
	if (fields.length === 0) {
		return "{}";
	}

	const indent = "\t".repeat(depth);
	const closingIndent = "\t".repeat(depth - 1);
	const lines = fields.map((field) => {
		const optional = field.optional ? "?" : "";
		const type = renderType(program, field.type, depth);
		return `${indent}${field.name}${optional}: ${type};`;
	});

	return `{\n${lines.join("\n")}\n${closingIndent}}`;
}

function renderType(program: Program, type: Type, depth = 0): string {
	switch (type.kind) {
		case "Scalar":
			return renderScalar(type);
		case "Model":
			return renderModel(program, type, depth);
		case "String":
			return "string";
		case "Number":
			return "number";
		case "Boolean":
			return "boolean";
		case "Union":
			return renderUnion(program, type, depth);
		case "Enum":
			return renderEnum(type);
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

function renderModel(program: Program, model: Model, depth = 0): string {
	if (model.name === "Array" && model.indexer?.value) {
		return `${renderType(program, model.indexer.value, depth)}[]`;
	}

	if (model.name === "Record" && model.indexer?.value) {
		return `Record<string, ${renderType(program, model.indexer.value, depth)}>`;
	}

	const searchableFields = Array.from(model.properties.values())
		.filter((prop) => isSearchable(program, prop))
		.map((prop) => ({
			name: prop.name,
			type: prop.type,
			optional: prop.optional,
		}));

	return renderBlock(program, searchableFields, depth + 1);
}

function renderEnum(enumType: Enum): string {
	const members = Array.from(enumType.members.values());
	if (members.length === 0) {
		return "never";
	}

	return members
		.map((m) => {
			const value = m.value !== undefined ? m.value : m.name;
			return typeof value === "string" ? `"${value}"` : String(value);
		})
		.join(" | ");
}

function renderUnion(program: Program, union: Union, depth = 0): string {
	const variants = Array.from(union.variants.values());
	if (variants.length === 0) {
		return "never";
	}

	return variants.map((x) => renderType(program, x.type, depth)).join(" | ");
}

export function toDocTypeFileName(projectionModelName: string): string {
	const kebab = toKebabCase(projectionModelName);
	const base = kebab.endsWith("-search-doc")
		? kebab.slice(0, -"-search-doc".length)
		: kebab;
	return `${base}-search-doc.ts`;
}

export const __test = {
	renderEnum,
	renderModel,
	renderScalar,
	renderType,
	renderUnion,
	toDocTypeFileName,
	toKebabCase,
};
