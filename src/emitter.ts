import type {
	EmitContext,
	Model,
	Namespace,
	Program,
} from "@typespec/compiler";
import { emitFile, resolvePath } from "@typespec/compiler";
import { emitDocType } from "./emit-doc-type.js";
import type { OpenSearchEmitterOptions } from "./lib.js";
import {
	isSearchProjectionModel,
	type ResolvedProjection,
	resolveProjectionModel,
} from "./projection.js";

export async function $onEmit(
	context: EmitContext<OpenSearchEmitterOptions>,
): Promise<void> {
	const outputFile =
		context.options["output-file"] ?? "opensearch-projections.json";

	const projectionModels = collectProjectionModels(
		context.program,
		context.program.getGlobalNamespaceType(),
	);
	if (projectionModels.length === 0) {
		return;
	}

	const resolved = projectionModels
		.map((model) => resolveProjectionModel(context.program, model))
		.filter((x): x is ResolvedProjection => x !== undefined);

	for (const projection of resolved) {
		const docTypeFile = emitDocType(context.program, projection);
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, docTypeFile.fileName),
			content: docTypeFile.content,
		});
	}

	await emitFile(context.program, {
		path: resolvePath(context.emitterOutputDir, outputFile),
		content: `${JSON.stringify(serializeProjections(resolved), null, 2)}\n`,
	});
}

function collectProjectionModels(
	program: Program,
	namespace: Namespace,
): Model[] {
	const models: Model[] = [];

	for (const model of namespace.models.values()) {
		if (
			isCandidateModel(model) &&
			!isTemplateDeclaration(model) &&
			isSearchProjectionModel(program, model)
		) {
			models.push(model);
		}
	}

	for (const child of namespace.namespaces.values()) {
		models.push(...collectProjectionModels(program, child));
	}

	return models;
}

function isCandidateModel(model: Model): boolean {
	if (
		model.name === "Array" ||
		model.name === "Record" ||
		model.name === "SearchProjection"
	) {
		return false;
	}

	const namespaceName = model.namespace?.name;
	if (namespaceName === "TypeSpec" || namespaceName === "Reflection") {
		return false;
	}

	return !!model.name;
}

function isTemplateDeclaration(model: Model): boolean {
	if (model.node && "templateParameters" in model.node) {
		const templateParams = (
			model.node as { templateParameters?: readonly unknown[] }
		).templateParameters;
		return !!templateParams && templateParams.length > 0;
	}

	return false;
}

function serializeProjections(resolved: ResolvedProjection[]) {
	return {
		projections: resolved.map((projection) => ({
			name: projection.projectionModel.name,
			sourceModel: projection.sourceModel.name,
			indexName: projection.indexName,
			fields: projection.fields.map((field) => ({
				name: field.name,
				optional: field.optional,
				keyword: field.keyword,
				nested: field.nested,
				analyzer: field.analyzer,
				boost: field.boost,
			})),
		})),
	};
}

export const __test = {
	collectProjectionModels,
	isCandidateModel,
	isTemplateDeclaration,
	serializeProjections,
};
