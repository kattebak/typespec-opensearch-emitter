import type {
	EmitContext,
	Model,
	Namespace,
	Program,
} from "@typespec/compiler";
import { emitFile, NoTarget, resolvePath } from "@typespec/compiler";
import { isSearchProjection } from "./decorators.js";
import {
	collectSubProjections,
	emitDocType,
	toDocTypeFileName,
} from "./emit-doc-type.js";
import {
	APPSYNC_FUNCTION_BYTE_LIMIT,
	DEFAULT_AUTO_DATE_HISTOGRAM_BUCKETS,
	type EmittedResolverFile,
	emitGraphQLResolver,
	MAX_PIPELINE_FUNCTIONS,
} from "./emit-graphql-resolver.js";
import { emitGraphQLSdl, resolveDirectives } from "./emit-graphql-sdl.js";
import { emitIndex } from "./emit-index.js";
import {
	emitJoinResolver,
	toJoinResolverFileName,
} from "./emit-join-resolver.js";
import { emitMapping } from "./emit-mapping.js";
import {
	type EmittedRestResolverFile,
	emitRestResolver,
	restResolverFileName,
} from "./emit-rest-resolver.js";
import {
	type EmitRestSdlOptions,
	emitRestSdl,
	restSdlFileName,
} from "./emit-rest-sdl.js";
import {
	collectStringModules,
	type EmittedStringModule,
	emitResolverStringModule,
	emitSdlStringModule,
	resolverModuleSpecifier,
	sdlModuleSpecifier,
} from "./emit-string-module.js";
import {
	type ResolvableByManifestEntry,
	toJoinDependencyManifestEntry,
} from "./joins.js";
import { type OpenSearchEmitterOptions, reportDiagnostic } from "./lib.js";
import {
	isSearchProjectionModel,
	type ResolvedProjection,
	resolveProjectionModel,
	type TopLevelProjection,
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

	const resolved: ResolvedProjection[] = projectionModels
		.map((model) => resolveProjectionModel(context.program, model))
		.filter((x): x is ResolvedProjection => x !== undefined);

	// Issue #123 — `is SearchProjection<T>` declares a projection-shaped type;
	// `@searchProjection` is the additional gate for *top-level* emission
	// (Query field, resolver, OS index, manifest entry). Undecorated models
	// are nested-only: they still get a doc type and a stripped SDL fragment
	// so siblings can reference them, but no top-level wiring. This is a
	// breaking change for fixtures relying on the old name-based behavior.
	//
	// Issue #157 — `@indexName` is the second gate. A projection with no
	// declared index has no index to query; emitting a Query field for it
	// produced resolvers that failed at runtime against a nonexistent index.
	const isTopLevel = (
		projection: ResolvedProjection,
	): projection is TopLevelProjection =>
		isSearchProjection(context.program, projection.projectionModel) &&
		projection.indexName !== undefined;

	const topLevel = resolved.filter(isTopLevel);
	const nestedOnly = resolved.filter((projection) => !isTopLevel(projection));

	reportDemotedProjections(context.program, nestedOnly);

	// Issue #184 — the `exports` map is built from the file names emission
	// actually used. Re-deriving them from the projection name produced a map
	// that named files no consumer could resolve as soon as a projection's
	// emitted shape stopped matching the assumed one.
	const artifactFileNames: string[] = [];

	// Issue #194 — a projection declaring `@dependsOn` ships the join-resolver
	// interface its declarations imply, top-level or nested-only alike.
	for (const projection of resolved) {
		const joinResolverFile = emitJoinResolver(context.program, projection);
		if (!joinResolverFile) continue;
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, joinResolverFile.fileName),
			content: joinResolverFile.content,
		});
	}

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
		artifactFileNames.push(mappingFile.fileName);
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
	// Issue #1068 — every emitted resolver, pipeline function and SDL fragment
	// also ships as a `.ts` module exporting its source as a string, so a
	// consumer imports the code instead of resolving and reading the file. The
	// `.js` / `.graphql` files stay: a local build directory has no package
	// exports to import through.
	const resolverModules: EmittedStringModule[] = [];
	const pipelineFunctionModules: EmittedStringModule[] = [];
	const sdlModules: EmittedStringModule[] = [];
	const stringModules: EmittedStringModule[] = [];
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
				graphqlOptions["monolithic-threshold-bytes"] ?? 31000,
			autoDateHistogramBuckets:
				graphqlOptions["auto-date-histogram-buckets"] ??
				DEFAULT_AUTO_DATE_HISTOGRAM_BUCKETS,
		};

		// Top-level projections get the full SDL + resolver + manifest entry.
		for (const projection of topLevel) {
			const sdlFile = emitGraphQLSdl(context.program, projection, pageOptions);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, sdlFile.fileName),
				content: sdlFile.content,
			});
			artifactFileNames.push(sdlFile.fileName);
			sdlModules.push(emitSdlStringModule(sdlFile.fileName, sdlFile.content));

			const resolverFile = await emitGraphQLResolver(
				projection,
				resolverOptions,
			);
			resolverFiles.push(resolverFile);
			assertResolverFilesFit(
				context.program,
				projection.projectionModel.name,
				resolverFile,
			);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, resolverFile.fileName),
				content: resolverFile.content,
			});
			artifactFileNames.push(resolverFile.fileName);
			resolverModules.push(
				emitResolverStringModule(resolverFile.fileName, resolverFile.content),
			);
			for (const fn of resolverFile.functions) {
				await emitFile(context.program, {
					path: resolvePath(context.emitterOutputDir, fn.fileName),
					content: fn.content,
				});
				artifactFileNames.push(fn.fileName);
				pipelineFunctionModules.push(
					emitResolverStringModule(fn.fileName, fn.content),
				);
			}
		}

		// Nested-only: stripped SDL fragment so parent projections that
		// reference the type by name get a definition in the assembled
		// schema. No resolver, no `resolvers[]` entry — issue #123. The
		// fragment is named in the manifest's `nestedTypes` (issue #164) so a
		// consumer assembling a schema from the manifest can find it.
		for (const projection of nestedOnly) {
			const sdlFile = emitGraphQLSdl(context.program, projection, {
				...pageOptions,
				topLevel: false,
			});
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, sdlFile.fileName),
				content: sdlFile.content,
			});
			artifactFileNames.push(sdlFile.fileName);
			sdlModules.push(emitSdlStringModule(sdlFile.fileName, sdlFile.content));
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
		const restSdlOptions: EmitRestSdlOptions = {
			sdlFileName: restOptions?.sdlFileName,
		};
		for (const sdlFile of emitRestSdl(
			context.program,
			restResolved,
			restSdlOptions,
		)) {
			restSdlFileNames.push(sdlFile.fileName);
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, sdlFile.fileName),
				content: sdlFile.content,
			});
			artifactFileNames.push(sdlFile.fileName);
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
			artifactFileNames.push(restResolverFile.fileName);
		}

		for (const module of collectStringModules(
			resolverModules,
			pipelineFunctionModules,
			sdlModules,
		)) {
			await emitFile(context.program, {
				path: resolvePath(context.emitterOutputDir, module.fileName),
				content: module.content,
			});
			stringModules.push(module);
		}

		const manifest = generateGraphQLManifest(
			topLevel,
			resolverFiles,
			queryFieldDirectivesByProjection,
			generateRestManifestEntries(
				restResolved,
				restOptions?.dataSourceName,
				resourcePathPrefix,
				restOptions?.sdlFileName,
			),
			generateNestedTypeEntries(nestedOnly),
		);
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, "graphql-resolvers.json"),
			content: manifest,
		});
		artifactFileNames.push("graphql-resolvers.json");

		const entryPoint = generateGraphQLEntryPoint();
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, "graphql-resolvers.js"),
			content: entryPoint,
		});
		artifactFileNames.push("graphql-resolvers.js");
	}

	if (packageName && packageVersion) {
		// Rest-only emit (issue #143): no projections means no doc types and no
		// index.ts barrel, so the package must not point at an entrypoint or
		// run tsc on publish — and there is nothing for a tsconfig to compile.
		const restOnly = projectionModels.length === 0;
		const packageJsonContent = generatePackageJson(
			packageName,
			packageVersion,
			artifactFileNames,
			restOnly,
			stringModules,
		);
		await emitFile(context.program, {
			path: resolvePath(context.emitterOutputDir, "package.json"),
			content: packageJsonContent,
		});

		if (!restOnly) {
			const tsConfigContent = generateTsConfig(resolved, stringModules);
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

function serializeProjections(resolved: TopLevelProjection[]) {
	return {
		projections: resolved.map((projection) => ({
			name: projection.projectionModel.name,
			sourceModel: projection.sourceModel.name,
			indexName: projection.indexName,
			...(projection.indexSettings
				? { indexSettings: projection.indexSettings }
				: {}),
			// `dependencies` (issue #194) is omitted when a projection declares
			// no `@dependsOn`, so an unjoined spec emits an unchanged manifest.
			...(projection.joins && projection.joins.length > 0
				? {
						dependencies: projection.joins.map(toJoinDependencyManifestEntry),
					}
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
	sdlFileName?: string,
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
		sdlFile: sdlFileName ?? restSdlFileName(op),
		// `resolvableBy` (issue #194) names the entity this read serves a join
		// for; omitted when the returned model declares none.
		...(op.resolvableBy ? { resolvableBy: op.resolvableBy } : {}),
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
	resolvableBy?: ResolvableByManifestEntry;
}

interface NestedTypeManifestEntry {
	projection: string;
	sdlFile: string;
	sdlModule: string;
}

/**
 * Nested-type manifest entries (issue #164). A nested-only projection has no
 * Query field, resolver, or index, so it has nothing to say in `resolvers[]`
 * — but its SDL fragment defines a type that top-level fragments reference by
 * name. Without it in the manifest, a schema assembled from
 * `resolvers[].sdlFile` alone dangles on that reference.
 */
function generateNestedTypeEntries(
	nestedOnly: ResolvedProjection[],
): NestedTypeManifestEntry[] {
	return nestedOnly.map((projection) => {
		const sdlFile = `${toKebabCase(projection.projectionModel.name)}.graphql`;
		return {
			projection: projection.projectionModel.name,
			sdlFile,
			sdlModule: sdlModuleSpecifier(sdlFile),
		};
	});
}

function generateGraphQLManifest(
	projections: TopLevelProjection[],
	resolverFiles: EmittedResolverFile[],
	queryFieldDirectives?: string[][],
	restEntries?: RestManifestEntry[],
	nestedTypes?: NestedTypeManifestEntry[],
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
		// `resolverModule` / `functions[].module` / `sdlModule` (issue #1068) name
		// the string-export module beside each file, so a consumer imports the
		// code instead of resolving and reading the path in the `*File` field.
		const sdlFile = `${toKebabCase(projection.projectionModel.name)}.graphql`;
		return {
			projection: projection.projectionModel.name,
			indexName: projection.indexName,
			queryFieldName: resolver.queryFieldName,
			...(directives && directives.length > 0
				? { queryFieldDirectives: directives }
				: {}),
			mode: resolver.mode,
			resolverFile: resolver.fileName,
			resolverModule: resolverModuleSpecifier(resolver.fileName),
			sdlFile,
			sdlModule: sdlModuleSpecifier(sdlFile),
			functions: resolver.functions.map((fn) => ({
				name: fn.name,
				file: fn.fileName,
				module: resolverModuleSpecifier(fn.fileName),
				dataSource: fn.dataSource,
			})),
		};
	});

	// REST entries (issue #134) append after the OpenSearch entries; with none
	// present the manifest is byte-identical to the OpenSearch-only emit.
	const allResolvers = [...resolvers, ...(restEntries ?? [])];

	// `nestedTypes` (issue #164) is omitted when no projection is nested-only,
	// so a spec without one emits a byte-identical manifest.
	return `${JSON.stringify(
		{
			resolvers: allResolvers,
			...(nestedTypes && nestedTypes.length > 0 ? { nestedTypes } : {}),
		},
		null,
		2,
	)}\n`;
}

/**
 * Issue #173 — hard-fail compile when the emitted resolver code cannot deploy,
 * so the over-cap case can never pass compile silently and only fail later at
 * AppSync `CreateFunction`. Two conditions: any generated AppSync function file
 * (the resolver-level after-mapping and every pipeline function) over the
 * 32,768-byte per-function code limit, and a pipeline needing more functions
 * than AppSync allows on one resolver. Both mean the recursive split ran out of
 * room and the projection must shed filter/aggregation surface.
 */
function assertResolverFilesFit(
	program: Program,
	projectionName: string,
	resolverFile: EmittedResolverFile,
): void {
	const files = [
		{ fileName: resolverFile.fileName, content: resolverFile.content },
		...resolverFile.functions.map((fn) => ({
			fileName: fn.fileName,
			content: fn.content,
		})),
	];
	for (const file of files) {
		const bytes = Buffer.byteLength(file.content, "utf-8");
		if (bytes > APPSYNC_FUNCTION_BYTE_LIMIT) {
			reportDiagnostic(program, {
				code: "resolver-function-too-large",
				format: { file: file.fileName, bytes: String(bytes) },
				target: NoTarget,
			});
		}
	}
	if (resolverFile.functions.length > MAX_PIPELINE_FUNCTIONS) {
		reportDiagnostic(program, {
			code: "pipeline-too-many-functions",
			format: {
				name: projectionName,
				count: String(resolverFile.functions.length),
			},
			target: NoTarget,
		});
	}
}

/**
 * Issue #157 — `@searchProjection` states an intent for top-level emission.
 * Without `@indexName` that intent is discarded, and the result is
 * byte-identical to an undecorated model, so the demotion is invisible in the
 * build output. Warn per demoted projection: regenerating a downstream package
 * then enumerates exactly which Query fields it lost.
 */
function reportDemotedProjections(
	program: Program,
	nestedOnly: ResolvedProjection[],
): void {
	for (const projection of nestedOnly) {
		if (!isSearchProjection(program, projection.projectionModel)) continue;
		reportDiagnostic(program, {
			code: "search-projection-without-index-name",
			format: { name: projection.projectionModel.name },
			target: projection.projectionModel,
		});
	}
}

export const __test = {
	collectProjectionModels,
	reportDemotedProjections,
	assertResolverFilesFit,
	isCandidateModel,
	isTemplateDeclaration,
	serializeProjections,
	generatePackageJson,
	generateTsConfig,
	generateGraphQLManifest,
	generateRestManifestEntries,
	generateNestedTypeEntries,
	generateGraphQLEntryPoint,
	validateResourcePathPrefix,
};

function generateTsConfig(
	projections: ResolvedProjection[],
	stringModules: EmittedStringModule[] = [],
): string {
	const tsFiles: string[] = ["index.ts"];

	for (const projection of projections) {
		tsFiles.push(toDocTypeFileName(projection.projectionModel.name));

		if (projection.joins && projection.joins.length > 0) {
			tsFiles.push(toJoinResolverFileName(projection.projectionModel.name));
		}

		for (const subProj of collectSubProjections(projection)) {
			const subFileName = toDocTypeFileName(subProj.projectionModel.name);
			if (!tsFiles.includes(subFileName)) {
				tsFiles.push(subFileName);
			}
		}
	}

	for (const module of stringModules) {
		if (!tsFiles.includes(module.fileName)) {
			tsFiles.push(module.fileName);
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

/**
 * `artifactFileNames` is the list emission recorded as it wrote each
 * consumer-facing artifact, so a subpath exists for exactly the files the
 * package ships — whatever shape the resolver emit chose (issue #184).
 * `stringModules` is the same list for the string-export modules (issue
 * #1068); each exports as an extensionless subpath resolving to the compiled
 * `.js` next to the emitted `.ts`.
 */
function generatePackageJson(
	packageName: string,
	packageVersion: string,
	artifactFileNames: string[],
	restOnly = false,
	stringModules: EmittedStringModule[] = [],
): string {
	const sorted = Object.fromEntries(
		[...new Set(artifactFileNames)]
			.sort((a, b) => a.localeCompare(b))
			.map((fileName) => [`./${fileName}`, `./${fileName}`]),
	);

	const moduleExports = Object.fromEntries(
		[...stringModules]
			.sort((a, b) => a.moduleSpecifier.localeCompare(b.moduleSpecifier))
			.map((module) => {
				const compiled = module.fileName.replace(/\.ts$/, "");
				return [
					`./${module.moduleSpecifier}`,
					{
						types: `./${compiled}.d.ts`,
						default: `./${compiled}.js`,
					},
				];
			}),
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
			...moduleExports,
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
