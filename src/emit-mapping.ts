import {
	type DiagnosticTarget,
	type Model,
	NoTarget,
	type Program,
	type Scalar,
	type Type,
	type Union,
} from "@typespec/compiler";
import {
	getAnalyzer,
	getBoost,
	getIgnoreAbove,
	getSearchAs,
	isKeyword,
	isNested,
	isSearchable,
} from "./decorators.js";
import { reportDiagnostic } from "./lib.js";
import type {
	ResolvedProjection,
	ResolvedProjectionField,
} from "./projection.js";
import { toKebabCase } from "./utils.js";

export interface EmittedMappingFile {
	fileName: string;
	content: string;
}

type MappingProperty = Record<string, unknown>;

interface MappingOverride {
	keyword?: boolean;
	nested?: boolean;
	analyzer?: string;
	boost?: number;
	ignoreAbove?: number;
}

/**
 * Identifies the field a mapping is being built for, so an unmappable type
 * reports a diagnostic naming the field rather than defaulting to "object".
 */
interface MappingContext {
	program: Program;
	field: string;
	target: DiagnosticTarget | typeof NoTarget;
}

export function emitMapping(
	program: Program,
	projection: ResolvedProjection,
	defaultIgnoreAbove?: number,
): EmittedMappingFile {
	const fileName = `${toKebabCase(projection.projectionModel.name)}-search-mapping.json`;
	const properties = buildPropertiesFromFields(
		program,
		projection.projectionModel.name,
		projection.fields,
		defaultIgnoreAbove,
	);

	const mappings: Record<string, unknown> = {
		mappings: { date_detection: false, properties },
	};

	if (projection.indexSettings) {
		(mappings as Record<string, unknown>).settings = projection.indexSettings;
	}

	return {
		fileName,
		content: `${JSON.stringify(mappings, null, 2)}\n`,
	};
}

function toMapping(
	context: MappingContext,
	type: Type,
	override?: MappingOverride,
	defaultIgnoreAbove?: number,
): MappingProperty {
	switch (type.kind) {
		case "Scalar":
			return mapScalar(context, type, override, defaultIgnoreAbove);
		case "Model":
			return mapModel(context, type, override, defaultIgnoreAbove);
		case "String":
			return mapString(override, defaultIgnoreAbove);
		case "Number":
			return { type: "double" };
		case "Boolean":
			return { type: "boolean" };
		case "Union":
			return mapUnion(context, type, override, defaultIgnoreAbove);
		case "Enum":
			return { type: "keyword" };
		default:
			reportDiagnostic(context.program, {
				code: "unsupported-field-type",
				format: { field: context.field, kind: type.kind },
				target: context.target,
			});
			return { type: "object" };
	}
}

function mapString(
	override?: MappingOverride,
	defaultIgnoreAbove?: number,
): MappingProperty {
	if (override?.keyword) {
		return { type: "keyword" };
	}

	const ignoreAbove = override?.ignoreAbove ?? defaultIgnoreAbove ?? 256;

	const mapping: MappingProperty = {
		type: "text",
		fields: {
			keyword: {
				type: "keyword",
				ignore_above: ignoreAbove,
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
	context: MappingContext,
	scalar: Scalar,
	override?: MappingOverride,
	defaultIgnoreAbove?: number,
): MappingProperty {
	let current: Scalar | undefined = scalar;
	while (current) {
		switch (current.name) {
			case "string":
				return mapString(override, defaultIgnoreAbove);
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
			// Base64 payload: stored, never indexed — which matches the empty
			// filter/aggregation set @searchInfer gives bytes.
			case "bytes":
				return { type: "binary" };
			case "utcDateTime":
			case "plainDate":
				return { type: "date" };
			case "offsetDateTime":
				return { type: "date", format: "strict_date_optional_time" };
			// OpenSearch has no time-of-day or duration type, and `date` anchors
			// both to an instant: it rejects "PT30M" outright and pins "09:30:00"
			// to 1970-01-01. Keyword indexes the ISO 8601 string as written, so
			// term/terms/exists work, and zero-padded plainTime still sorts and
			// ranges chronologically. Issue #165.
			case "plainTime":
			case "duration":
				return { type: "keyword" };
		}
		current = current.baseScalar;
	}

	reportDiagnostic(context.program, {
		code: "unsupported-scalar-type",
		format: { field: context.field, scalar: scalar.name },
		target: context.target,
	});
	return { type: "object" };
}

function buildPropertiesFromFields(
	program: Program,
	path: string,
	fields: ResolvedProjectionField[],
	defaultIgnoreAbove?: number,
): Record<string, MappingProperty> {
	return Object.fromEntries(
		fields.map((field) => [
			field.projectedName ?? field.name,
			field.subProjection
				? mapSubProjectionField(program, path, field, defaultIgnoreAbove)
				: toMapping(
						{
							program,
							field: `${path}.${field.name}`,
							target: field.sourceProperty ?? NoTarget,
						},
						field.type,
						{
							// A filter-only / agg-only string field has no full-text-search
							// surface, so map it as plain keyword instead of text+keyword.
							keyword: field.keyword || !field.searchable,
							nested: field.nested,
							analyzer: field.analyzer,
							boost: field.boost,
							ignoreAbove: field.ignoreAbove,
						},
						defaultIgnoreAbove,
					),
		]),
	);
}

function mapSubProjectionField(
	program: Program,
	path: string,
	field: ResolvedProjectionField,
	defaultIgnoreAbove?: number,
): MappingProperty {
	const subProjection = field.subProjection!;
	const properties = buildPropertiesFromFields(
		program,
		`${path}.${field.name}`,
		subProjection.fields,
		defaultIgnoreAbove,
	);
	return {
		type: field.nested ? "nested" : "object",
		properties,
	};
}

function mapModel(
	context: MappingContext,
	model: Model,
	override?: MappingOverride,
	defaultIgnoreAbove?: number,
): MappingProperty {
	if (model.name === "Array" && model.indexer?.value) {
		const elementType = model.indexer.value;
		if (elementType.kind === "Model") {
			return {
				type: override?.nested ? "nested" : "object",
				properties: mapModelProperties(
					context,
					elementType,
					defaultIgnoreAbove,
				),
			};
		}
		// An array maps as its element type, so the field's own directives
		// apply to the element (filters and aggregations already address a
		// @keyword array by its bare name). Issue #187.
		return toMapping(context, elementType, override, defaultIgnoreAbove);
	}

	return {
		type: "object",
		properties: mapModelProperties(context, model, defaultIgnoreAbove),
	};
}

function mapModelProperties(
	context: MappingContext,
	model: Model,
	defaultIgnoreAbove?: number,
): Record<string, MappingProperty> {
	return Object.fromEntries(
		Array.from(model.properties.values())
			.filter((prop) => isSearchable(context.program, prop))
			.map((prop) => [
				getSearchAs(context.program, prop) ?? prop.name,
				toMapping(
					{
						program: context.program,
						field: `${context.field}.${prop.name}`,
						target: prop,
					},
					prop.type,
					{
						keyword: isKeyword(context.program, prop),
						nested: isNested(context.program, prop),
						analyzer: getAnalyzer(context.program, prop),
						boost: getBoost(context.program, prop),
						ignoreAbove: getIgnoreAbove(context.program, prop),
					},
					defaultIgnoreAbove,
				),
			]),
	);
}

function mapUnion(
	context: MappingContext,
	union: Union,
	override?: MappingOverride,
	defaultIgnoreAbove?: number,
): MappingProperty {
	for (const variant of union.variants.values()) {
		if (variant.type.kind === "Scalar" || variant.type.kind === "String") {
			return toMapping(context, variant.type, override, defaultIgnoreAbove);
		}
	}
	reportDiagnostic(context.program, {
		code: "unsupported-field-type",
		messageId: "union",
		format: { field: context.field },
		target: context.target,
	});
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
