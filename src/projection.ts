import type { Model, ModelProperty, Program, Type } from "@typespec/compiler";
import {
	type AggregationKind,
	type FilterableKind,
	getAggregatableKinds,
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
} from "./decorators.js";

function isReachable(program: Program, prop: ModelProperty): boolean {
	return (
		isSearchable(program, prop) ||
		hasFilterable(program, prop) ||
		hasAggregatable(program, prop)
	);
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
	analyzer?: string;
	boost?: number;
	ignoreAbove?: number;
	aggregations?: AggregationKind[];
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

	const fields: ResolvedProjectionField[] = [];
	for (const sourceProperty of sourceModel.properties.values()) {
		if (!isReachable(program, sourceProperty)) {
			continue;
		}

		const projectionProperty = projectionModel.properties.get(
			sourceProperty.name,
		);
		const field = resolveProjectionField(
			program,
			sourceProperty,
			projectionProperty,
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
			if (!isReachable(program, spreadSourceProp)) {
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
			const field = resolveProjectionField(program, spreadSourceProp, projProp);

			// Check for sub-projection on the projection property
			const subProj = resolveSubProjectionFromType(program, projProp.type);
			if (subProj) {
				field.subProjection = subProj;
			}

			fields.push(field);
			resolvedFieldNames.add(projProp.name);
			continue;
		}

		if (!sourceProp || !isReachable(program, sourceProp)) {
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

	const aggregations =
		(projectionProperty && getAggregatableKinds(program, projectionProperty)) ??
		getAggregatableKinds(program, sourceProperty);

	const filterables =
		(projectionProperty && getFilterableKinds(program, projectionProperty)) ??
		getFilterableKinds(program, sourceProperty);

	return {
		name: sourceProperty.name,
		projectedName: searchAs,
		type: projectionProperty?.type ?? sourceProperty.type,
		optional: projectionProperty?.optional ?? sourceProperty.optional,
		sourceProperty,
		projectionProperty,
		searchable: isSearchable(program, sourceProperty),
		keyword:
			(projectionProperty && isKeyword(program, projectionProperty)) ||
			isKeyword(program, sourceProperty),
		nested:
			(projectionProperty && isNested(program, projectionProperty)) ||
			isNested(program, sourceProperty),
		analyzer,
		boost,
		ignoreAbove,
		aggregations,
		filterables,
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

	const fields: ResolvedProjectionField[] = [];
	for (const sourceProperty of sourceModel.properties.values()) {
		if (!isReachable(program, sourceProperty)) {
			continue;
		}

		const projectionProperty = model.properties.get(sourceProperty.name);
		const field = resolveProjectionField(
			program,
			sourceProperty,
			projectionProperty,
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
