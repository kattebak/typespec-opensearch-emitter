import type {
	EmitContext,
	Model,
	Namespace,
	Program,
} from "@typespec/compiler";
import { emitFile, resolvePath } from "@typespec/compiler";
import { collectSubProjections, emitDocType } from "./emit-doc-type.js";
import { emitIndex } from "./emit-index.js";
import { emitMapping } from "./emit-mapping.js";
import type { OpenSearchEmitterOptions } from "./lib.js";
import {
	isSearchProjectionModel,
	type ResolvedProjection,
	resolveProjectionModel,
} from "./projection.js";
import { toKebabCase } from "./utils.js";

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

		// Emit sub-projection doc type files
		for (const subProj of collectSubProjections(projection)) {
			const subDocTypeFile = emitDocType(context.program, subProj);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, subDocTypeFile.fileName),
				content: subDocTypeFile.content,
			});
		}

		const mappingFile = emitMapping(
			context.program,
			projection,
			context.options["default-ignore-above"],
		);
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, mappingFile.fileName),
			content: mappingFile.content,
		});
	}

	const indexFile = emitIndex(resolved);
	await emitFile(context.program, {
		path: resolvePath(context.emitterOutputDir, indexFile.fileName),
		content: indexFile.content,
	});

	await emitFile(context.program, {
		path: resolvePath(context.emitterOutputDir, outputFile),
		content: `${JSON.stringify(serializeProjections(resolved), null, 2)}\n`,
	});

	const packageName = context.options["package-name"];
	const packageVersion = context.options["package-version"];

	if (packageName && packageVersion) {
		const packageJsonContent = generatePackageJson(
			packageName,
			packageVersion,
			resolved,
		);
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, "package.json"),
			content: packageJsonContent,
		});
	}
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
			...(projection.indexSettings
				? { indexSettings: projection.indexSettings }
				: {}),
			fields: projection.fields.map((field) => ({
				name: field.name,
				...(field.projectedName ? { projectedName: field.projectedName } : {}),
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
	generatePackageJson,
};

function generatePackageJson(
	packageName: string,
	packageVersion: string,
	projections: ResolvedProjection[],
): string {
	const mappingExports: Record<string, string> = {};

	for (const projection of projections) {
		const baseName = `${toKebabCase(projection.projectionModel.name)}-search-mapping`;
		mappingExports[`./${baseName}.json`] = `./${baseName}.json`;
	}

	const sorted = Object.fromEntries(
		Object.entries(mappingExports).sort(([a], [b]) => a.localeCompare(b)),
	);

	const packageJson = {
		name: packageName,
		version: packageVersion,
		type: "module" as const,
		main: "./index.js",
		types: "./index.d.ts",
		exports: {
			".": {
				types: "./index.d.ts",
				default: "./index.js",
			},
			...sorted,
		},
		scripts: {
			prepare: "tsc",
		},
		devDependencies: {
			typescript: "^5.0.0",
		},
	};

	return `${JSON.stringify(packageJson, null, 2)}\n`;
}
