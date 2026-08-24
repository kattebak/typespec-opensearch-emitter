import type { Model, Program, Type } from "@typespec/compiler";

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
