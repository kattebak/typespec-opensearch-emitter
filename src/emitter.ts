import type {
	EmitContext,
	Model,
	Namespace,
	Program,
} from "@typespec/compiler";
import { emitFile, resolvePath } from "@typespec/compiler";
import { isSearchProjection } from "./decorators.js";
import {
	collectSubProjections,
	emitDocType,
	toDocTypeFileName,
} from "./emit-doc-type.js";
import {
	type EmittedResolverFile,
	emitGraphQLResolver,
} from "./emit-graphql-resolver.js";
import { emitGraphQLSdl, resolveDirectives } from "./emit-graphql-sdl.js";
import { emitIndex } from "./emit-index.js";
import { emitMapping } from "./emit-mapping.js";
import {
	type EmittedRestResolverFile,
	emitRestResolver,
	restResolverFileName,
} from "./emit-rest-resolver.js";
import { emitRestSdl, restSdlFileName } from "./emit-rest-sdl.js";
import type { OpenSearchEmitterOptions } from "./lib.js";
import {
	isSearchProjectionModel,
	type ResolvedProjection,
	resolveProjectionModel,
} from "./projection.js";
import {
	collectRestOperations,
	type ResolvedRestOperation,
	resolveRestOperation,
} from "./rest-operations.js";
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
	// Issue #134 — `@restResolver` operations are a second, independent
	// discovery path; a spec can be rest-only, projection-only, or both.
	const restOperations = collectRestOperations(
		context.program,
		context.program.getGlobalNamespaceType(),
	);
	if (projectionModels.length === 0 && restOperations.length === 0) {
		return;
	}

	const resolved = projectionModels
		.map((model) => resolveProjectionModel(context.program, model))
		.filter((x): x is ResolvedProjection => x !== undefined);

	// Issue #123 — `is SearchProjection<T>` declares a projection-shaped type;
	// `@searchProjection` is the additional gate for *top-level* emission
	// (Query field, resolver, OS index, manifest entry). Undecorated models
	// are nested-only: they still get a doc type and a stripped SDL fragment
	// so siblings can reference them, but no top-level wiring. This is a
	// breaking change for fixtures relying on the old name-based behavior.
	const topLevel = resolved.filter((projection) =>
		isSearchProjection(context.program, projection.projectionModel),
	);
	const nestedOnly = resolved.filter(
		(projection) =>
			!isSearchProjection(context.program, projection.projectionModel),
	);

	for (const projection of topLevel) {
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

	// Doc types for nested-only projections: still emit the TS interface so
	// downstream code can name the shape. No mapping (no backing OS index).
	for (const projection of nestedOnly) {
		const docTypeFile = emitDocType(context.program, projection);
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, docTypeFile.fileName),
			content: docTypeFile.content,
		});
		for (const subProj of collectSubProjections(projection)) {
			const subDocTypeFile = emitDocType(context.program, subProj);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, subDocTypeFile.fileName),
				content: subDocTypeFile.content,
			});
		}
	}

	// OpenSearch index + projections JSON only when projections exist — a
	// rest-only spec (issue #134) has no backing OS index to describe.
	if (projectionModels.length > 0) {
		const indexFile = emitIndex(topLevel);
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, indexFile.fileName),
			content: indexFile.content,
		});

		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, outputFile),
			content: `${JSON.stringify(serializeProjections(topLevel), null, 2)}\n`,
		});
	}

	const packageName = context.options["package-name"];
	const packageVersion = context.options["package-version"];
	const graphqlOptions = context.options.graphql;
	const resolverFiles: EmittedResolverFile[] = [];
	const restResolverFiles: EmittedRestResolverFile[] = [];
	const restSdlFileNames: string[] = [];
	if (graphqlOptions?.emit) {
		const directiveDefaults = graphqlOptions.directives?.default;
		const pageOptions = {
			defaultPageSize: graphqlOptions["default-page-size"] ?? 20,
			maxPageSize: graphqlOptions["max-page-size"] ?? 100,
			directives: directiveDefaults,
		};
		const resolverOptions = {
			defaultPageSize: pageOptions.defaultPageSize,
			maxPageSize: pageOptions.maxPageSize,
			trackTotalHitsUpTo: graphqlOptions["track-total-hits-up-to"] ?? 10000,
			monolithicThresholdBytes:
				graphqlOptions["monolithic-threshold-bytes"] ?? 32000,
		};

		// Top-level projections get the full SDL + resolver + manifest entry.
		for (const projection of topLevel) {
			const sdlFile = emitGraphQLSdl(context.program, projection, pageOptions);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, sdlFile.fileName),
				content: sdlFile.content,
			});

			const resolverFile = await emitGraphQLResolver(
				projection,
				resolverOptions,
			);
			resolverFiles.push(resolverFile);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, resolverFile.fileName),
				content: resolverFile.content,
			});
			for (const fn of resolverFile.functions) {
				await emitFile(context.program, {
					path: resolvePath(context.emitterOutputDir, fn.fileName),
					content: fn.content,
				});
			}
		}

		// Nested-only: stripped SDL fragment so parent projections that
		// reference the type by name get a definition in the assembled
		// schema. No resolver, no manifest entry — issue #123.
		for (const projection of nestedOnly) {
			const sdlFile = emitGraphQLSdl(context.program, projection, {
				...pageOptions,
				topLevel: false,
			});
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, sdlFile.fileName),
				content: sdlFile.content,
			});
		}

		// Issue #121 — Query field directives go in the manifest, not the SDL
		// fragment. The fragment carries response-path types only; consumers
		// assemble the Query type from the manifest's queryFieldName + (now)
		// queryFieldDirectives. Resolved per-projection so each entry sees the
		// projection's own `@graphqlDirectives` override.
		const queryFieldDirectivesByProjection = topLevel.map((projection) =>
			resolveDirectives(
				context.program,
				projection.projectionModel,
				directiveDefaults,
			),
		);

		// REST resolvers (issue #134) — a parallel, additive path. New modules
		// only; with no @restResolver operations these loops are no-ops and the
		// manifest stays byte-identical to the OpenSearch-only emit.
		const restOptions = context.options.rest;
		const resourcePathPrefix = validateResourcePathPrefix(
			restOptions?.resourcePathPrefix,
		);
		const restResolved = restOperations.map((operation) =>
			resolveRestOperation(context.program, operation),
		);
		for (const sdlFile of emitRestSdl(context.program, restResolved)) {
			restSdlFileNames.push(sdlFile.fileName);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, sdlFile.fileName),
				content: sdlFile.content,
			});
		}
		for (const restOperation of restResolved) {
			const restResolverFile = emitRestResolver(restOperation, {
				injectHeaders: restOptions?.injectHeaders,
				errorMap: restOptions?.errorMap,
				resourcePathPrefix,
			});
			restResolverFiles.push(restResolverFile);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, restResolverFile.fileName),
				content: restResolverFile.content,
			});
		}

		const manifest = generateGraphQLManifest(
			topLevel,
			resolverFiles,
			queryFieldDirectivesByProjection,
			generateRestManifestEntries(
				restResolved,
				restOptions?.dataSourceName,
				resourcePathPrefix,
			),
		);
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
		// `topLevel` for graphql artifacts (issue #123): nested-only projections
		// have only an SDL fragment, no resolver / pipeline / mapping, so they
		// don't merit a separate exports entry. The fragment is still needed,
		// though — track it via `nestedOnly` so the .graphql file gets exported.
		const graphqlArtifacts = graphqlOptions?.emit ? topLevel : undefined;
		// Rest-only emit (issue #143): no projections means no doc types and no
		// index.ts barrel, so the package must not point at an entrypoint or
		// run tsc on publish — and there is nothing for a tsconfig to compile.
		const restOnly = projectionModels.length === 0;
		const packageJsonContent = generatePackageJson(
			packageName,
			packageVersion,
			topLevel,
			graphqlArtifacts,
			graphqlOptions?.emit ? resolverFiles : undefined,
			graphqlOptions?.emit ? nestedOnly : undefined,
			graphqlOptions?.emit
				? [
						...restSdlFileNames,
						...restResolverFiles.map((file) => file.fileName),
					]
				: undefined,
			restOnly,
		);
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, "package.json"),
			content: packageJsonContent,
		});

		if (!restOnly) {
			const tsConfigContent = generateTsConfig(resolved);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, "tsconfig.json"),
				content: tsConfigContent,
			});
		}
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
				...(field.aggregations && field.aggregations.length > 0
					? { aggregations: field.aggregations.map((d) => d.kind) }
					: {}),
			})),
		})),
	};
}

/**
 * REST manifest entries (issue #134). Reuses the graphql-resolvers.json
 * contract so the same CDK construct wires both resolver kinds; REST entries
 * carry `typeName` / `httpMethod` / `resourcePath` / `dataSource` instead of
 * `projection` / `indexName` / `queryFieldName` (`indexName` is optional in
 * the manifest shape — REST entries have no backing OS index).
 */
function generateRestManifestEntries(
	restOperations: ResolvedRestOperation[],
	dataSourceName?: string,
	resourcePathPrefix?: string,
): RestManifestEntry[] {
	const prefix = resourcePathPrefix ?? "";
	return restOperations.map((op) => ({
		typeName: op.typeName,
		fieldName: op.fieldName,
		dataSource: dataSourceName ?? "HTTP",
		httpMethod: op.httpMethod,
		resourcePath: `${prefix}${op.path}`,
		mode: "monolithic",
		resolverFile: restResolverFileName(op),
		sdlFile: restSdlFileName(op),
	}));
}

/**
 * Validates `rest.resourcePathPrefix` (issue #140). Must start with `/` and
 * must not end with `/`. Returns the validated string, or `undefined` when
 * no prefix is configured (preserves current behavior).
 */
function validateResourcePathPrefix(prefix?: string): string | undefined {
	if (prefix === undefined || prefix === "") return undefined;
	if (!prefix.startsWith("/")) {
		throw new Error(`rest.resourcePathPrefix "${prefix}" must start with "/"`);
	}
	if (prefix.endsWith("/")) {
		throw new Error(
			`rest.resourcePathPrefix "${prefix}" must not end with "/"`,
		);
	}
	return prefix;
}

interface RestManifestEntry {
	typeName: string;
	fieldName: string;
	dataSource: string;
	httpMethod: string;
	resourcePath: string;
	mode: "monolithic";
	resolverFile: string;
	sdlFile: string;
}

function generateGraphQLManifest(
	projections: ResolvedProjection[],
	resolverFiles: EmittedResolverFile[],
	queryFieldDirectives?: string[][],
	restEntries?: RestManifestEntry[],
): string {
	const resolvers = projections.map((projection, i) => {
		const resolver = resolverFiles[i];
		const directives = queryFieldDirectives?.[i];
		// `mode` (issue #112) tells the consumer which AppSync resolver kind
		// to wire — UNIT for `monolithic`, PIPELINE for `pipeline`. The
		// `functions` array is empty under `monolithic` and ignored by the
		// consumer in that case. `queryFieldDirectives` (issue #121) — when
		// non-empty, lists GraphQL directives the consumer must attach to
		// the Query field (e.g. AppSync auth modes); omitted entirely when
		// no directives apply so unaffected manifests stay byte-identical.
		return {
			projection: projection.projectionModel.name,
			indexName: projection.indexName,
			queryFieldName: resolver.queryFieldName,
			...(directives && directives.length > 0
				? { queryFieldDirectives: directives }
				: {}),
			mode: resolver.mode,
			resolverFile: resolver.fileName,
			sdlFile: `${toKebabCase(projection.projectionModel.name)}.graphql`,
			functions: resolver.functions.map((fn) => ({
				name: fn.name,
				file: fn.fileName,
				dataSource: fn.dataSource,
			})),
		};
	});

	// REST entries (issue #134) append after the OpenSearch entries; with none
	// present the manifest is byte-identical to the OpenSearch-only emit.
	const allResolvers = [...resolvers, ...(restEntries ?? [])];

	return `${JSON.stringify({ resolvers: allResolvers }, null, 2)}\n`;
}

export const __test = {
	collectProjectionModels,
	isCandidateModel,
	isTemplateDeclaration,
	serializeProjections,
	generatePackageJson,
	generateTsConfig,
	generateGraphQLManifest,
	generateRestManifestEntries,
	generateGraphQLEntryPoint,
	validateResourcePathPrefix,
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
	resolverFiles?: EmittedResolverFile[],
	nestedOnlyGraphqlProjections?: ResolvedProjection[],
	restArtifactFileNames?: string[],
	restOnly = false,
): string {
	const artifactExports: Record<string, string> = {};

	for (const projection of projections) {
		const baseName = `${toKebabCase(projection.projectionModel.name)}-search-mapping`;
		artifactExports[`./${baseName}.json`] = `./${baseName}.json`;
	}

	if (graphqlProjections) {
		artifactExports["./graphql-resolvers.json"] = "./graphql-resolvers.json";
		artifactExports["./graphql-resolvers.js"] = "./graphql-resolvers.js";
		const filesByName = new Map<string, EmittedResolverFile>();
		if (resolverFiles) {
			for (let i = 0; i < graphqlProjections.length; i++) {
				filesByName.set(
					graphqlProjections[i].projectionModel.name,
					resolverFiles[i],
				);
			}
		}
		for (const projection of graphqlProjections) {
			const kebab = toKebabCase(projection.projectionModel.name);
			artifactExports[`./${kebab}.graphql`] = `./${kebab}.graphql`;
			artifactExports[`./${kebab}-resolver.js`] = `./${kebab}-resolver.js`;
			// Pipeline functions (prepare/search) only exist on the disk for
			// projections emitted in pipeline mode (issue #112). Monolithic
			// projections collapse those into the resolver file. Only export
			// what's actually present.
			const file = filesByName.get(projection.projectionModel.name);
			if (file && file.mode === "pipeline") {
				artifactExports[`./${kebab}-fn-prepare.js`] =
					`./${kebab}-fn-prepare.js`;
				artifactExports[`./${kebab}-fn-search.js`] = `./${kebab}-fn-search.js`;
			}
		}
		// Nested-only projections (issue #123): SDL fragment only — no resolver,
		// no pipeline functions, no mapping. The fragment must still be
		// exported so consumers' schema-assembly tooling can read it.
		if (nestedOnlyGraphqlProjections) {
			for (const projection of nestedOnlyGraphqlProjections) {
				const kebab = toKebabCase(projection.projectionModel.name);
				artifactExports[`./${kebab}.graphql`] = `./${kebab}.graphql`;
			}
		}
		// REST artifacts (issue #134): SDL fragments + Query/Mutation resolver
		// files. Only present when @restResolver operations exist.
		if (restArtifactFileNames) {
			for (const fileName of restArtifactFileNames) {
				artifactExports[`./${fileName}`] = `./${fileName}`;
			}
		}
	}

	const sorted = Object.fromEntries(
		Object.entries(artifactExports).sort(([a], [b]) => a.localeCompare(b)),
	);

	// Rest-only package (issue #143): SDL / resolver / manifest artifacts only —
	// no index.ts entrypoint exists, so no main/types/"." export and no tsc run.
	if (restOnly) {
		const restPackageJson = {
			name: packageName,
			version: packageVersion,
			type: "module" as const,
			exports: sorted,
		};

		return `${JSON.stringify(restPackageJson, null, 2)}\n`;
	}

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
