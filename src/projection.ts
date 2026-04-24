import type { Model, ModelProperty, Program, Type } from "@typespec/compiler";
import {
	getAnalyzer,
	getBoost,
	getIgnoreAbove,
	getIndexName,
	getIndexSettings,
	getSearchAs,
	isKeyword,
	isNested,
	isSearchable,
} from "./decorators.js";
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
		if (!isSearchable(program, sourceProperty)) {
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

	for (const projProp of projectionModel.properties.values()) {
		const sourceProp = sourceModel.properties.get(projProp.name);
		if (!sourceProp || !isSearchable(program, sourceProp)) {
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

	return {
		name: sourceProperty.name,
		projectedName: searchAs,
		type: projectionProperty?.type ?? sourceProperty.type,
		optional: projectionProperty?.optional ?? sourceProperty.optional,
		sourceProperty,
		projectionProperty,
		searchable: true,
		keyword:
			(projectionProperty && isKeyword(program, projectionProperty)) ||
			isKeyword(program, sourceProperty),
		nested:
			(projectionProperty && isNested(program, projectionProperty)) ||
			isNested(program, sourceProperty),
		analyzer,
		boost,
		ignoreAbove,
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
		if (!isSearchable(program, sourceProperty)) {
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
