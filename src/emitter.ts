import type { EmitContext, Model, Namespace } from "@typespec/compiler";
import { emitFile, resolvePath } from "@typespec/compiler";
import type { OpenSearchEmitterOptions } from "./lib.js";

export async function $onEmit(
	context: EmitContext<OpenSearchEmitterOptions>,
): Promise<void> {
	const outputFile =
		context.options["output-file"] ?? "opensearch-projections.json";
	const models: string[] = [];

	collectModels(context.program.getGlobalNamespaceType(), models);

	await emitFile(context.program, {
		path: resolvePath(context.emitterOutputDir, outputFile),
		content: `${JSON.stringify({ models }, null, 2)}\n`,
	});
}

function collectModels(namespace: Namespace, models: string[]): void {
	for (const model of namespace.models.values()) {
		if (isUserModel(model)) {
			models.push(model.name);
		}
	}

	for (const child of namespace.namespaces.values()) {
		collectModels(child, models);
	}
}

function isUserModel(model: Model): boolean {
	if (model.name === "Array" || model.name === "Record") {
		return false;
	}

	const namespaceName = model.namespace?.name;
	if (namespaceName === "TypeSpec" || namespaceName === "Reflection") {
		return false;
	}

	return !!model.name;
}

export const __test = {
	collectModels,
	isUserModel,
};
