import type {
	EmitContext,
	Model,
	Namespace,
	Program,
} from "@typespec/compiler";
import { emitFile, resolvePath } from "@typespec/compiler";
import {
	collectSubProjections,
	emitDocType,
	toDocTypeFileName,
} from "./emit-doc-type.js";
import {
	type EmittedResolverFile,
	emitGraphQLResolver,
} from "./emit-graphql-resolver.js";
import { emitGraphQLSdl } from "./emit-graphql-sdl.js";
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
	const graphqlOptions = context.options.graphql;
	if (graphqlOptions?.emit) {
		const pageOptions = {
			defaultPageSize: graphqlOptions["default-page-size"] ?? 20,
			maxPageSize: graphqlOptions["max-page-size"] ?? 100,
		};
		const resolverOptions = {
			...pageOptions,
			trackTotalHitsUpTo: graphqlOptions["track-total-hits-up-to"] ?? 10000,
		};

		const resolverFiles: EmittedResolverFile[] = [];

		for (const projection of resolved) {
			const sdlFile = emitGraphQLSdl(context.program, projection, pageOptions);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, sdlFile.fileName),
				content: sdlFile.content,
			});

			const resolverFile = emitGraphQLResolver(projection, resolverOptions);
			resolverFiles.push(resolverFile);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, resolverFile.fileName),
				content: resolverFile.content,
			});
		}

		const manifest = generateGraphQLManifest(resolved, resolverFiles);
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, "graphql-resolvers.json"),
			content: manifest,
		});

		const entryPoint = generateGraphQLEntryPoint();
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, "graphql-resolvers.js"),
			content: entryPoint,
		});
	}

	if (packageName && packageVersion) {
		const graphqlArtifacts = graphqlOptions?.emit ? resolved : undefined;
		const packageJsonContent = generatePackageJson(
			packageName,
			packageVersion,
			resolved,
			graphqlArtifacts,
		);
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, "package.json"),
			content: packageJsonContent,
		});

		const tsConfigContent = generateTsConfig(resolved);
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, "tsconfig.json"),
			content: tsConfigContent,
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

function generateGraphQLManifest(
	projections: ResolvedProjection[],
	resolverFiles: EmittedResolverFile[],
): string {
	const resolvers = projections.map((projection, i) => {
		const resolver = resolverFiles[i];
		return {
			projection: projection.projectionModel.name,
			indexName: projection.indexName,
			queryFieldName: resolver.queryFieldName,
			resolverFile: resolver.fileName,
			sdlFile: `${toKebabCase(projection.projectionModel.name)}.graphql`,
		};
	});

	return `${JSON.stringify({ resolvers }, null, 2)}\n`;
}

export const __test = {
	collectProjectionModels,
	isCandidateModel,
	isTemplateDeclaration,
	serializeProjections,
	generatePackageJson,
	generateTsConfig,
	generateGraphQLManifest,
	generateGraphQLEntryPoint,
};

function generateTsConfig(projections: ResolvedProjection[]): string {
	const tsFiles: string[] = ["index.ts"];

	for (const projection of projections) {
		tsFiles.push(toDocTypeFileName(projection.projectionModel.name));

		for (const subProj of collectSubProjections(projection)) {
			const subFileName = toDocTypeFileName(subProj.projectionModel.name);
			if (!tsFiles.includes(subFileName)) {
				tsFiles.push(subFileName);
			}
		}
	}

	tsFiles.sort();

	const tsConfig = {
		compilerOptions: {
			module: "NodeNext",
			moduleResolution: "NodeNext",
			target: "ES2020",
			strict: true,
			skipLibCheck: true,
			declaration: true,
			outDir: ".",
		},
		include: tsFiles,
		exclude: ["node_modules"],
	};

	return `${JSON.stringify(tsConfig, null, 2)}\n`;
}

function generateGraphQLEntryPoint(): string {
	return `import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageDir = dirname(fileURLToPath(import.meta.url));
export const manifest = JSON.parse(
  readFileSync(join(packageDir, "graphql-resolvers.json"), "utf-8")
);
export default manifest;
`;
}

function generatePackageJson(
	packageName: string,
	packageVersion: string,
	projections: ResolvedProjection[],
	graphqlProjections?: ResolvedProjection[],
): string {
	const artifactExports: Record<string, string> = {};

	for (const projection of projections) {
		const baseName = `${toKebabCase(projection.projectionModel.name)}-search-mapping`;
		artifactExports[`./${baseName}.json`] = `./${baseName}.json`;
	}

	if (graphqlProjections) {
		artifactExports["./graphql-resolvers.json"] = "./graphql-resolvers.json";
		artifactExports["./graphql-resolvers.js"] = "./graphql-resolvers.js";
		for (const projection of graphqlProjections) {
			const kebab = toKebabCase(projection.projectionModel.name);
			artifactExports[`./${kebab}.graphql`] = `./${kebab}.graphql`;
			artifactExports[`./${kebab}-resolver.js`] = `./${kebab}-resolver.js`;
		}
	}

	const sorted = Object.fromEntries(
		Object.entries(artifactExports).sort(([a], [b]) => a.localeCompare(b)),
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
