import type { Model, ModelProperty, Program, Type } from "@typespec/compiler";
import {
	type AggregationDirective,
	type FilterableKind,
	getAggregatableDirectives,
	getAnalyzer,
	getBoost,
	getFilterableKinds,
	getIgnoreAbove,
	getIndexName,
	getIndexSettings,
	getSearchAs,
	hasAggregatable,
	hasFilterable,
	isKeyword,
	isNested,
	isSearchable,
	isSearchInfer,
	isSearchSkip,
	isSortable,
} from "./decorators.js";

function isReachable(
	program: Program,
	prop: ModelProperty,
	inferOnModel: boolean,
): boolean {
	if (
		isSearchable(program, prop) ||
		hasFilterable(program, prop) ||
		hasAggregatable(program, prop)
	) {
		return true;
	}
	// On a @searchInfer model, every source-model field is reachable unless
	// the field opts out with @searchSkip. Inference (see inferDirectives)
	// fills in the filterable/aggregatable axes per field type.
	return inferOnModel && !isSearchSkip(program, prop);
}

import { reportDiagnostic } from "./lib.js";

export interface ResolvedProjectionField {
	name: string;
	projectedName?: string;
	type: Type;
	optional: boolean;
	sourceProperty: ModelProperty;
	projectionProperty?: ModelProperty;
	searchable: boolean;
	keyword: boolean;
	nested: boolean;
	sortable: boolean;
	analyzer?: string;
	boost?: number;
	ignoreAbove?: number;
	aggregations?: AggregationDirective[];
	filterables?: FilterableKind[];
	subProjection?: ResolvedProjection;
}

export interface ResolvedProjection {
	projectionModel: Model;
	sourceModel: Model;
	indexName: string;
	indexSettings?: Record<string, unknown>;
	fields: ResolvedProjectionField[];
}

export function isSearchProjectionModel(
	program: Program,
	model: Model,
): boolean {
	return !!getProjectionSourceModel(program, model);
}

export function getProjectionSourceModel(
	_program: Program,
	projectionModel: Model,
): Model | undefined {
	if (projectionModel.name === "SearchProjection") {
		return undefined;
	}

	const isSource = projectionModel.sourceModels.find(
		(x) => x.usage === "is" && x.model.name === "SearchProjection",
	);
	if (!isSource) {
		return undefined;
	}

	// The instantiated SearchProjection<T> model carries a templateMapper
	// whose first arg is the resolved source model T.
	const sourceModel = isSource.model as Model & {
		templateMapper?: { args?: readonly Type[] };
	};
	const sourceType = sourceModel.templateMapper?.args?.[0];
	return sourceType?.kind === "Model" ? sourceType : undefined;
}

export function resolveProjectionModel(
	program: Program,
	projectionModel: Model,
): ResolvedProjection | undefined {
	const sourceModel = getProjectionSourceModel(program, projectionModel);
	if (!sourceModel) {
		return undefined;
	}

	const inferOnModel = isSearchInfer(program, projectionModel);

	const fields: ResolvedProjectionField[] = [];
	for (const sourceProperty of sourceModel.properties.values()) {
		if (!isReachable(program, sourceProperty, inferOnModel)) {
			continue;
		}

		const projectionProperty = projectionModel.properties.get(
			sourceProperty.name,
		);
		const field = resolveProjectionField(
			program,
			sourceProperty,
			projectionProperty,
			inferOnModel,
		);

		// Check if the projection redeclares this field with a sub-projection type
		if (projectionProperty) {
			const subProj = resolveSubProjectionFromType(
				program,
				projectionProperty.type,
			);
			if (subProj) {
				field.subProjection = subProj;
			}
		}

		// @searchInfer auto-recurses into struct fields (issue #98). When the
		// field's type resolves to a plain TypeSpec model (no explicit
		// SearchProjection<T>), build a virtual sub-projection so the parent
		// SearchFilter can reference <NestedType>SearchFilter.
		if (
			inferOnModel &&
			!field.subProjection &&
			!isSearchSkip(program, sourceProperty)
		) {
			const virtual = buildVirtualSubProjection(
				program,
				field.type,
				new Set([projectionModel.name]),
			);
			if (virtual) {
				field.subProjection = virtual;
			}
		}

		fields.push(field);
	}

	// Collect names already resolved from the source model
	const resolvedFieldNames = new Set(fields.map((f) => f.name));

	for (const projProp of projectionModel.properties.values()) {
		const sourceProp = sourceModel.properties.get(projProp.name);

		// Check if this property came from a spread of a different model
		const isSpreadFromOtherModel =
			projProp.sourceProperty &&
			projProp.sourceProperty.model &&
			projProp.sourceProperty.model !== sourceModel &&
			projProp.sourceProperty.model !== projectionModel;

		if (isSpreadFromOtherModel) {
			const spreadSourceProp = projProp.sourceProperty!;

			// Only include reachable fields from the spread source
			if (!isReachable(program, spreadSourceProp, inferOnModel)) {
				continue;
			}

			// Check for collision with already-resolved fields
			if (resolvedFieldNames.has(projProp.name)) {
				reportDiagnostic(program, {
					code: "spread-field-collision",
					format: { name: projProp.name },
					target: projProp,
				});
				continue;
			}

			// Resolve the spread field using the spread source property
			const field = resolveProjectionField(
				program,
				spreadSourceProp,
				projProp,
				inferOnModel,
			);

			// Check for sub-projection on the projection property
			const subProj = resolveSubProjectionFromType(program, projProp.type);
			if (subProj) {
				field.subProjection = subProj;
			}

			fields.push(field);
			resolvedFieldNames.add(projProp.name);
			continue;
		}

		if (!sourceProp || !isReachable(program, sourceProp, inferOnModel)) {
			// Allow sub-projection fields that reference a valid source field
			const subProj = resolveSubProjectionFromType(program, projProp.type);
			if (!subProj || !sourceProp) {
				reportDiagnostic(program, {
					code: "projection-field-not-on-source",
					format: { name: projProp.name, sourceModel: sourceModel.name },
					target: projProp,
				});
			}
		}
	}

	return {
		projectionModel,
		sourceModel,
		indexName: getIndexName(program, projectionModel),
		indexSettings: getIndexSettings(program, projectionModel),
		fields,
	};
}

function resolveProjectionField(
	program: Program,
	sourceProperty: ModelProperty,
	projectionProperty?: ModelProperty,
	inferOnModel = false,
): ResolvedProjectionField {
	const analyzer =
		(projectionProperty && getAnalyzer(program, projectionProperty)) ??
		getAnalyzer(program, sourceProperty);
	const boost =
		(projectionProperty && getBoost(program, projectionProperty)) ??
		getBoost(program, sourceProperty);
	const ignoreAbove =
		(projectionProperty && getIgnoreAbove(program, projectionProperty)) ??
		getIgnoreAbove(program, sourceProperty);

	const searchAs =
		(projectionProperty && getSearchAs(program, projectionProperty)) ??
		getSearchAs(program, sourceProperty);

	const explicitAggregations =
		(projectionProperty &&
			getAggregatableDirectives(program, projectionProperty)) ??
		getAggregatableDirectives(program, sourceProperty);

	const explicitFilterables =
		(projectionProperty && getFilterableKinds(program, projectionProperty)) ??
		getFilterableKinds(program, sourceProperty);

	const fieldType = projectionProperty?.type ?? sourceProperty.type;
	const keyword =
		(projectionProperty && isKeyword(program, projectionProperty)) ||
		isKeyword(program, sourceProperty);
	const nested =
		(projectionProperty && isNested(program, projectionProperty)) ||
		isNested(program, sourceProperty);

	// @searchInfer fills empty axes from the inference table. Explicit
	// decorators on either axis still win on that axis (the other axis
	// gets inferred independently). @searchSkip on the source property
	// suppresses inference entirely.
	const skipInference = isSearchSkip(program, sourceProperty);
	const inferred =
		inferOnModel && !skipInference
			? inferDirectives(fieldType, { keyword, nested })
			: undefined;

	const aggregations =
		explicitAggregations ?? inferred?.aggregations ?? undefined;
	const filterables = explicitFilterables ?? inferred?.filterables ?? undefined;

	const explicitSortable =
		(projectionProperty && isSortable(program, projectionProperty)) ||
		isSortable(program, sourceProperty);
	const inferredSortable =
		inferOnModel &&
		!skipInference &&
		isSortableType(fieldType, { keyword, nested });
	const sortable = explicitSortable || inferredSortable;

	return {
		name: sourceProperty.name,
		projectedName: searchAs,
		type: fieldType,
		optional: projectionProperty?.optional ?? sourceProperty.optional,
		sourceProperty,
		projectionProperty,
		searchable: isSearchable(program, sourceProperty),
		keyword,
		nested,
		sortable,
		analyzer,
		boost,
		ignoreAbove,
		aggregations,
		filterables,
	};
}

interface InferredDirectives {
	filterables?: FilterableKind[];
	aggregations?: AggregationDirective[];
}

/**
 * Type-driven defaults for fields on a `@searchInfer` model.
 *
 * Per issue #92's inference table:
 * - utcDateTime / plainDate → range filter, date_histogram(month) agg
 * - string + @keyword → term/exists filter, terms agg
 * - free-text string (no @keyword) → none, none
 * - numeric → range filter, sum/avg/min/max aggs
 * - boolean → term filter, no agg
 * - @nested array → exists (path-level) filter, no agg (sub-projection
 *   carries its own @searchInfer if desired)
 * - enum / scalar union → term/exists filter, terms agg
 * - bytes → none, none
 */
function inferDirectives(
	type: Type,
	flags: { keyword: boolean; nested: boolean },
): InferredDirectives {
	if (flags.nested) {
		return { filterables: ["exists"] };
	}

	if (type.kind === "Enum") {
		return {
			filterables: ["term", "terms", "exists"],
			aggregations: [{ kind: "terms" }],
		};
	}
	if (type.kind === "Union") {
		return {
			filterables: ["term", "terms", "exists"],
			aggregations: [{ kind: "terms" }],
		};
	}
	if (type.kind === "Boolean") {
		return { filterables: ["term", "terms"] };
	}
	if (type.kind === "Scalar") {
		const root = scalarRootName(type);
		if (root === "boolean") return { filterables: ["term", "terms"] };
		if (root === "utcDateTime" || root === "plainDate") {
			return {
				filterables: ["range"],
				aggregations: [
					{ kind: "date_histogram", options: { interval: "month" } },
				],
			};
		}
		if (isNumericRootName(root)) {
			return {
				filterables: ["range"],
				aggregations: [
					{ kind: "sum" },
					{ kind: "avg" },
					{ kind: "min" },
					{ kind: "max" },
				],
			};
		}
		if (root === "string") {
			if (flags.keyword) {
				return {
					filterables: ["term", "terms", "exists"],
					aggregations: [{ kind: "terms" }],
				};
			}
			// Free-text string — too ambiguous to infer.
			return {};
		}
		if (root === "bytes") return {};
	}
	if (type.kind === "String") {
		// Plain string literal type — same call as string. @keyword tells us
		// whether to enable term/terms; without it, leave alone.
		if (flags.keyword) {
			return {
				filterables: ["term", "exists"],
				aggregations: [{ kind: "terms" }],
			};
		}
		return {};
	}
	return {};
}

/**
 * @searchInfer treats a field as sortable when its type unambiguously orders:
 * keyword strings, numerics, dates, and booleans. Free-text strings and
 * @nested arrays are excluded — sorting them is either ill-defined
 * (text relevance is sort by score) or requires picking an element.
 */
function isSortableType(
	type: Type,
	flags: { keyword: boolean; nested: boolean },
): boolean {
	if (flags.nested) return false;
	if (type.kind === "Boolean") return true;
	if (type.kind === "Enum" || type.kind === "Union") return true;
	if (type.kind === "String") return flags.keyword;
	if (type.kind === "Scalar") {
		const root = scalarRootName(type);
		if (!root) return false;
		if (root === "boolean") return true;
		if (root === "utcDateTime" || root === "plainDate") return true;
		if (isNumericRootName(root)) return true;
		if (root === "string") return flags.keyword;
	}
	return false;
}

function scalarRootName(type: Type): string | undefined {
	let current: Type | undefined = type;
	while (current && current.kind === "Scalar") {
		if (!current.baseScalar) return current.name;
		current = current.baseScalar;
	}
	return undefined;
}

function isNumericRootName(name: string | undefined): boolean {
	if (!name) return false;
	return [
		"int8",
		"int16",
		"int32",
		"int64",
		"integer",
		"safeint",
		"uint8",
		"uint16",
		"uint32",
		"uint64",
		"float",
		"float32",
		"float64",
		"decimal",
		"numeric",
		"number",
	].includes(name);
}

/**
 * Build a virtual sub-projection for a struct or array-of-struct field on a
 * `@searchInfer` parent (issue #98). Recurses into the model's properties,
 * applying the inference table to each. The parent's SearchFilter exposes
 * `<fieldName>: <NestedType>SearchFilter`, and FILTER_SPEC dispatch threads
 * the dotted path (or nested wrapper if the field is `@nested`).
 */
function buildVirtualSubProjection(
	program: Program,
	type: Type,
	visited: Set<string>,
): ResolvedProjection | undefined {
	let model: Model | undefined;
	if (type.kind === "Model") {
		if (
			type.name === "Array" &&
			type.indexer?.value?.kind === "Model" &&
			type.indexer.value.name !== "Array"
		) {
			model = type.indexer.value;
		} else if (type.name && type.name !== "Array" && type.properties) {
			model = type;
		}
	}
	if (!model || !model.properties || model.properties.size === 0) {
		return undefined;
	}
	// Skip explicit SearchProjection<T> instantiations — those are handled
	// by resolveSubProjectionFromType.
	if (getProjectionSourceModel(program, model)) {
		return undefined;
	}
	if (visited.has(model.name)) {
		return undefined;
	}
	const childVisited = new Set(visited);
	childVisited.add(model.name);

	const fields: ResolvedProjectionField[] = [];
	for (const prop of model.properties.values()) {
		if (isSearchSkip(program, prop)) continue;
		const field = resolveProjectionField(program, prop, undefined, true);
		if (!field.subProjection) {
			const nestedVirtual = buildVirtualSubProjection(
				program,
				field.type,
				childVisited,
			);
			if (nestedVirtual) {
				field.subProjection = nestedVirtual;
			}
		}
		fields.push(field);
	}

	if (fields.length === 0) return undefined;

	return {
		projectionModel: model,
		sourceModel: model,
		indexName: getIndexName(program, model),
		fields,
	};
}

/**
 * Given a Type, check if it is (or is an array of) a SearchProjection model,
 * and if so resolve it recursively.
 */
function resolveSubProjectionFromType(
	program: Program,
	type: Type,
): ResolvedProjection | undefined {
	// Handle direct model reference: TagSearchDoc
	if (type.kind === "Model") {
		// Handle Array<TagSearchDoc> — e.g. TagSearchDoc[]
		if (type.name === "Array" && type.indexer?.value?.kind === "Model") {
			return resolveSubProjectionModel(program, type.indexer.value);
		}
		return resolveSubProjectionModel(program, type);
	}
	return undefined;
}

function resolveSubProjectionModel(
	program: Program,
	model: Model,
): ResolvedProjection | undefined {
	const sourceModel = getProjectionSourceModel(program, model);
	if (!sourceModel) {
		return undefined;
	}

	const inferOnModel = isSearchInfer(program, model);

	const fields: ResolvedProjectionField[] = [];
	for (const sourceProperty of sourceModel.properties.values()) {
		if (!isReachable(program, sourceProperty, inferOnModel)) {
			continue;
		}

		const projectionProperty = model.properties.get(sourceProperty.name);
		const field = resolveProjectionField(
			program,
			sourceProperty,
			projectionProperty,
			inferOnModel,
		);

		if (projectionProperty) {
			const subProj = resolveSubProjectionFromType(
				program,
				projectionProperty.type,
			);
			if (subProj) {
				field.subProjection = subProj;
			}
		}

		fields.push(field);
	}

	return {
		projectionModel: model,
		sourceModel,
		indexName: getIndexName(program, model),
		indexSettings: getIndexSettings(program, model),
		fields,
	};
}

export const __test = {
	getProjectionSourceModel,
	isSearchProjectionModel,
	resolveProjectionField,
};
