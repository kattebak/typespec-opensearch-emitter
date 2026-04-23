import type { Model, ModelProperty, Program, Type } from "@typespec/compiler";
import {
	getAnalyzer,
	getBoost,
	getIndexName,
	isKeyword,
	isNested,
	isSearchable,
} from "./decorators.js";

export interface ResolvedProjectionField {
	name: string;
	type: Type;
	optional: boolean;
	sourceProperty: ModelProperty;
	projectionProperty?: ModelProperty;
	searchable: boolean;
	keyword: boolean;
	nested: boolean;
	analyzer?: string;
	boost?: number;
}

export interface ResolvedProjection {
	projectionModel: Model;
	sourceModel: Model;
	indexName: string;
	fields: ResolvedProjectionField[];
}

export function isSearchProjectionModel(
	program: Program,
	model: Model,
): boolean {
	return !!getProjectionSourceModel(program, model);
}

export function getProjectionSourceModel(
	program: Program,
	projectionModel: Model,
): Model | undefined {
	if (projectionModel.name === "SearchProjection") {
		return undefined;
	}

	if (projectionModel.sourceModel?.name !== "SearchProjection") {
		return undefined;
	}

	const isExpression =
		projectionModel.node && "is" in projectionModel.node
			? (projectionModel.node.is as
					| { arguments?: readonly unknown[] }
					| undefined)
			: undefined;
	const arg = isExpression?.arguments?.[0];
	if (!arg) {
		return undefined;
	}

	const sourceType = program.checker.getTypeForNode(arg as never);
	return sourceType.kind === "Model" ? sourceType : undefined;
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
		fields.push(
			resolveProjectionField(program, sourceProperty, projectionProperty),
		);
	}

	return {
		projectionModel,
		sourceModel,
		indexName: getIndexName(program, projectionModel),
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

	return {
		name: sourceProperty.name,
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
	};
}

export const __test = {
	getProjectionSourceModel,
	isSearchProjectionModel,
	resolveProjectionField,
};
