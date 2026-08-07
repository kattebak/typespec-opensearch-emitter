import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "@typespec/compiler";
import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import {
	emitResolverBarrel,
	emitResolverStringModule,
	emitSdlBarrel,
	emitSdlStringModule,
} from "./emit-string-module.js";
import { __test } from "./emitter.js";
import {
	type ResolvedProjection,
	resolveProjectionModel,
} from "./projection.js";
import type { ResolvedRestOperation } from "./rest-operations.js";
import { OpenSearchEmitterTestLibrary } from "./testing/index.js";

async function createRunner() {
	const host = await createTestHost({
		libraries: [OpenSearchEmitterTestLibrary],
	});

	return createTestWrapper(host, {
		autoImports: ["@kattebak/typespec-opensearch-emitter"],
		autoUsings: ["Kattebak.OpenSearch"],
	});
}

describe("emitter model collection", () => {
	it("collects only SearchProjection<T> models", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
        hidden: string;
      }

      model ProductSearchDoc is SearchProjection<Product> {}
      model Inventory {}
    `);

		assert.equal(diagnostics.length, 0);

		const models = __test.collectProjectionModels(
			runner.program,
			runner.program.getGlobalNamespaceType(),
		);
		assert.deepEqual(
			models.map((x) => x.name),
			["ProductSearchDoc"],
		);
	});

	it("collects models inside a custom namespace", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
      }

      namespace MyApp.Search {
        model ProductSearchDoc is SearchProjection<Product> {}
      }
    `);

		assert.equal(diagnostics.length, 0);

		const models = __test.collectProjectionModels(
			runner.program,
			runner.program.getGlobalNamespaceType(),
		);
		assert.deepEqual(
			models.map((x) => x.name),
			["ProductSearchDoc"],
		);
	});

	it("collects multiple projections from different namespaces", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
      }

      model Order {
        @searchable orderId: string;
      }

      namespace App.Products {
        model ProductSearchDoc is SearchProjection<Product> {}
      }

      namespace App.Orders {
        model OrderSearchDoc is SearchProjection<Order> {}
      }
    `);

		assert.equal(diagnostics.length, 0);

		const models = __test.collectProjectionModels(
			runner.program,
			runner.program.getGlobalNamespaceType(),
		);
		const names = models.map((x) => x.name).sort();
		assert.deepEqual(names, ["OrderSearchDoc", "ProductSearchDoc"]);
	});

	it("serializes resolved projections", () => {
		const projections = [
			{
				projectionModel: { name: "ProductSearchDoc" },
				sourceModel: { name: "Product" },
				indexName: "product_search_doc",
				fields: [
					{
						name: "name",
						optional: false,
						keyword: true,
						nested: false,
						analyzer: "edge_ngram",
						boost: 2,
					},
				],
			},
		] as unknown as ResolvedProjection[];
		const serialized = __test.serializeProjections(projections);

		assert.deepEqual(serialized, {
			projections: [
				{
					name: "ProductSearchDoc",
					sourceModel: "Product",
					indexName: "product_search_doc",
					fields: [
						{
							name: "name",
							optional: false,
							keyword: true,
							nested: false,
							analyzer: "edge_ngram",
							boost: 2,
						},
					],
				},
			],
		});
	});
});

describe("isCandidateModel", () => {
	it("returns false for Array", () => {
		const model = {
			name: "Array",
			namespace: { name: "" },
		} as unknown as Model;
		assert.equal(__test.isCandidateModel(model), false);
	});

	it("returns false for Record", () => {
		const model = {
			name: "Record",
			namespace: { name: "" },
		} as unknown as Model;
		assert.equal(__test.isCandidateModel(model), false);
	});

	it("returns false for SearchProjection", () => {
		const model = {
			name: "SearchProjection",
			namespace: { name: "" },
		} as unknown as Model;
		assert.equal(__test.isCandidateModel(model), false);
	});

	it("returns false for models in the TypeSpec namespace", () => {
		const model = {
			name: "SomeModel",
			namespace: { name: "TypeSpec" },
		} as unknown as Model;
		assert.equal(__test.isCandidateModel(model), false);
	});

	it("returns false for models in the Reflection namespace", () => {
		const model = {
			name: "SomeModel",
			namespace: { name: "Reflection" },
		} as unknown as Model;
		assert.equal(__test.isCandidateModel(model), false);
	});

	it("returns true for a regular named model", () => {
		const model = {
			name: "Product",
			namespace: { name: "MyApp" },
		} as unknown as Model;
		assert.equal(__test.isCandidateModel(model), true);
	});

	it("returns false for anonymous models (empty name)", () => {
		const model = {
			name: "",
			namespace: { name: "MyApp" },
		} as unknown as Model;
		assert.equal(__test.isCandidateModel(model), false);
	});
});

describe("generatePackageJson", () => {
	it("generates a minimal package.json with index and mapping exports", () => {
		const result = JSON.parse(
			__test.generatePackageJson("@my/pkg", "1.0.0", [
				"product-search-doc-search-mapping.json",
			]),
		);

		assert.equal(result.name, "@my/pkg");
		assert.equal(result.version, "1.0.0");
		assert.equal(result.type, "module");
		assert.equal(result.main, "./index.js");
		assert.equal(result.types, "./index.d.ts");
		assert.deepEqual(result.exports["."], {
			types: "./index.d.ts",
			default: "./index.js",
		});
		assert.equal(
			result.exports["./product-search-doc-search-mapping.json"],
			"./product-search-doc-search-mapping.json",
		);
	});

	it("sorts artifact exports alphabetically", () => {
		const result = JSON.parse(
			__test.generatePackageJson("@my/pkg", "2.0.0", [
				"zeta-search-doc-search-mapping.json",
				"alpha-search-doc-search-mapping.json",
			]),
		);
		const exportKeys = Object.keys(result.exports);

		assert.equal(exportKeys[0], ".");
		assert.equal(exportKeys[1], "./alpha-search-doc-search-mapping.json");
		assert.equal(exportKeys[2], "./zeta-search-doc-search-mapping.json");
	});

	it("omits package.json when options are not provided", () => {
		const result = JSON.parse(
			__test.generatePackageJson("@my/pkg", "1.0.0", []),
		);
		const exportKeys = Object.keys(result.exports);
		assert.equal(exportKeys.length, 1);
		assert.equal(exportKeys[0], ".");
	});

	it("exports one subpath per emitted artifact, whatever its name", () => {
		const artifacts = [
			"graphql-resolvers.json",
			"graphql-resolvers.js",
			"product-search-doc.graphql",
			"product-search-doc-resolver.js",
			"product-search-doc-fn-prepare-query.js",
			"product-search-doc-fn-prepare-query-1.js",
			"product-search-doc-fn-prepare-aggs.js",
			"product-search-doc-fn-normalize.js",
			"product-search-doc-fn-search.js",
		];

		const result = JSON.parse(
			__test.generatePackageJson("@my/pkg", "1.0.0", artifacts),
		);

		assert.deepEqual(
			Object.keys(result.exports)
				.filter((key) => key !== ".")
				.sort(),
			artifacts.map((fileName) => `./${fileName}`).sort(),
		);
	});

	it("collapses an artifact emitted for more than one projection", () => {
		const result = JSON.parse(
			__test.generatePackageJson("@my/pkg", "1.0.0", [
				"pet.graphql",
				"pet.graphql",
			]),
		);

		assert.deepEqual(Object.keys(result.exports), [".", "./pet.graphql"]);
	});

	it("drops the entrypoint for a rest-only package", () => {
		const result = JSON.parse(
			__test.generatePackageJson("@my/pkg", "1.0.0", ["pet.graphql"], true),
		);

		assert.equal(result.main, undefined);
		assert.equal(result.scripts, undefined);
		assert.deepEqual(Object.keys(result.exports), ["./pet.graphql"]);
	});

	it("exports each string module as an extensionless conditional subpath (issue #1068)", () => {
		const result = JSON.parse(
			__test.generatePackageJson(
				"@my/pkg",
				"1.0.0",
				["pet-search-doc-resolver.js"],
				false,
				[
					emitResolverStringModule("pet-search-doc-resolver.js", "code"),
					emitSdlStringModule("pet-search-doc.graphql", "type Pet"),
					emitResolverBarrel([], []),
					emitSdlBarrel([]),
				],
			),
		);

		assert.deepEqual(result.exports["./resolvers/pet-search-doc-resolver"], {
			types: "./resolvers/pet-search-doc-resolver.d.ts",
			default: "./resolvers/pet-search-doc-resolver.js",
		});
		assert.deepEqual(result.exports["./schema/pet-search-doc"], {
			types: "./schema/pet-search-doc.d.ts",
			default: "./schema/pet-search-doc.js",
		});
		// The barrel's subpath is the directory; it resolves to the index inside.
		assert.deepEqual(result.exports["./resolvers"], {
			types: "./resolvers/index.d.ts",
			default: "./resolvers/index.js",
		});
		assert.deepEqual(result.exports["./schema"], {
			types: "./schema/index.d.ts",
			default: "./schema/index.js",
		});
		assert.equal(
			result.exports["./pet-search-doc-resolver.js"],
			"./pet-search-doc-resolver.js",
		);
	});

	it("keeps the exports map unchanged when nothing was emitted as a string module", () => {
		const withModules = __test.generatePackageJson(
			"@my/pkg",
			"1.0.0",
			["pet.graphql"],
			false,
			[],
		);
		const withoutModules = __test.generatePackageJson("@my/pkg", "1.0.0", [
			"pet.graphql",
		]);

		assert.equal(withModules, withoutModules);
	});
});

describe("generateTsConfig", () => {
	it("generates tsconfig with index.ts and doc-type files", () => {
		const projections = [
			{
				projectionModel: { name: "ProductSearchDoc" },
				sourceModel: { name: "Product" },
				indexName: "product_search_doc",
				fields: [],
			},
		] as unknown as ResolvedProjection[];

		const result = JSON.parse(__test.generateTsConfig(projections));

		assert.deepEqual(result.compilerOptions, {
			module: "NodeNext",
			moduleResolution: "NodeNext",
			target: "ES2020",
			strict: true,
			skipLibCheck: true,
			declaration: true,
			outDir: ".",
		});
		assert.deepEqual(result.include, ["index.ts", "product-search-doc.ts"]);
		assert.deepEqual(result.exclude, ["node_modules"]);
	});

	it("sorts include entries alphabetically", () => {
		const projections = [
			{
				projectionModel: { name: "ZetaSearchDoc" },
				sourceModel: { name: "Zeta" },
				indexName: "zeta",
				fields: [],
			},
			{
				projectionModel: { name: "AlphaSearchDoc" },
				sourceModel: { name: "Alpha" },
				indexName: "alpha",
				fields: [],
			},
		] as unknown as ResolvedProjection[];

		const result = JSON.parse(__test.generateTsConfig(projections));
		assert.deepEqual(result.include, [
			"alpha-search-doc.ts",
			"index.ts",
			"zeta-search-doc.ts",
		]);
	});

	it("returns tsconfig with only index.ts when no projections", () => {
		const result = JSON.parse(__test.generateTsConfig([]));
		assert.deepEqual(result.include, ["index.ts"]);
	});

	it("compiles the string modules the package ships (issue #1068)", () => {
		const result = JSON.parse(
			__test.generateTsConfig(
				[],
				[
					emitResolverStringModule("pet-search-doc-resolver.js", "code"),
					emitSdlStringModule("pet-search-doc.graphql", "type Pet"),
					emitResolverBarrel([], []),
					emitSdlBarrel([]),
				],
			),
		);

		assert.deepEqual(result.include, [
			"index.ts",
			"resolvers/index.ts",
			"resolvers/pet-search-doc-resolver.ts",
			"schema/index.ts",
			"schema/pet-search-doc.ts",
		]);
	});
});

describe("generateGraphQLEntryPoint", () => {
	it("generates a JS module that exports manifest and packageDir", () => {
		const result = __test.generateGraphQLEntryPoint();

		assert.ok(result.includes("export const packageDir"));
		assert.ok(result.includes("export const manifest"));
		assert.ok(result.includes("export default manifest"));
		assert.ok(result.includes("graphql-resolvers.json"));
	});
});

describe("generateGraphQLManifest queryFieldDirectives (issue #121)", () => {
	const projection = {
		projectionModel: { name: "PetSearchDoc" },
		sourceModel: { name: "Pet" },
		indexName: "pets_v1",
		fields: [],
	} as unknown as ResolvedProjection;

	const resolverFile = {
		queryFieldName: "searchPet",
		mode: "monolithic",
		fileName: "pet-search-doc-resolver.js",
		content: "",
		functions: [],
	};

	it("omits queryFieldDirectives entirely when no directives apply (default behavior)", () => {
		const manifest = JSON.parse(
			__test.generateGraphQLManifest([projection], [resolverFile]),
		);
		assert.equal(manifest.resolvers.length, 1);
		// Field must not be present at all so unaffected manifests stay
		// byte-identical to pre-issue-121 emit.
		assert.ok(!("queryFieldDirectives" in manifest.resolvers[0]));
	});

	it("includes queryFieldDirectives when the projection resolves to a non-empty list", () => {
		const manifest = JSON.parse(
			__test.generateGraphQLManifest(
				[projection],
				[resolverFile],
				[["@aws_cognito_user_pools", "@aws_iam"]],
			),
		);
		assert.deepEqual(manifest.resolvers[0].queryFieldDirectives, [
			"@aws_cognito_user_pools",
			"@aws_iam",
		]);
	});

	it("omits queryFieldDirectives when the projection resolves to an empty list (model opted out)", () => {
		// Projection-level `@graphqlDirectives([])` opts out of a globally
		// configured default. The manifest should reflect "no directives" by
		// omitting the field, not by carrying an empty array — that lets the
		// consumer treat presence as the signal.
		const manifest = JSON.parse(
			__test.generateGraphQLManifest([projection], [resolverFile], [[]]),
		);
		assert.ok(!("queryFieldDirectives" in manifest.resolvers[0]));
	});
});

describe("generateGraphQLManifest string modules (issue #1068)", () => {
	const projection = {
		projectionModel: { name: "PetSearchDoc" },
		sourceModel: { name: "Pet" },
		indexName: "pets_v1",
		fields: [],
	} as unknown as ResolvedProjection;

	it("names the string module beside every file field it already carries", () => {
		const resolverFile = {
			queryFieldName: "searchPet",
			mode: "pipeline",
			fileName: "pet-search-doc-resolver.js",
			content: "",
			functions: [
				{
					name: "prepare-query",
					fileName: "pet-search-doc-fn-prepare-query.js",
					content: "",
					dataSource: "NONE" as const,
				},
				{
					name: "normalize-1",
					fileName: "pet-search-doc-fn-normalize-1.js",
					content: "",
					dataSource: "NONE" as const,
				},
			],
		};

		const manifest = JSON.parse(
			__test.generateGraphQLManifest([projection], [resolverFile]),
		);
		const entry = manifest.resolvers[0];

		assert.equal(entry.resolverFile, "pet-search-doc-resolver.js");
		assert.equal(entry.resolverModule, "resolvers/pet-search-doc-resolver");
		assert.equal(entry.sdlFile, "pet-search-doc.graphql");
		assert.equal(entry.sdlModule, "schema/pet-search-doc");
		assert.deepEqual(
			entry.functions.map((fn: { file: string; module: string }) => fn),
			[
				{
					name: "prepare-query",
					file: "pet-search-doc-fn-prepare-query.js",
					module: "resolvers/pet-search-doc-fn-prepare-query",
					dataSource: "NONE",
				},
				{
					name: "normalize-1",
					file: "pet-search-doc-fn-normalize-1.js",
					module: "resolvers/pet-search-doc-fn-normalize-1",
					dataSource: "NONE",
				},
			],
		);
	});
});

describe("generateNestedTypeEntries (issue #164)", () => {
	const petSearchDoc = {
		projectionModel: { name: "PetSearchDoc" },
		sourceModel: { name: "Pet" },
		indexName: "pets_v1",
		fields: [],
	} as unknown as ResolvedProjection;

	const petResolverFile = {
		queryFieldName: "searchPet",
		mode: "monolithic",
		fileName: "pet-search-doc-resolver.js",
		content: "",
		functions: [],
	};

	const tagSearchDoc = {
		projectionModel: { name: "TagSearchDoc" },
		sourceModel: { name: "Tag" },
		indexName: undefined,
		fields: [],
	} as unknown as ResolvedProjection;

	it("names each nested-only projection and its SDL fragment", () => {
		assert.deepEqual(__test.generateNestedTypeEntries([tagSearchDoc]), [
			{
				projection: "TagSearchDoc",
				sdlFile: "tag-search-doc.graphql",
				sdlModule: "schema/tag-search-doc",
			},
		]);
	});

	it("lists the nested type alongside the parent's resolver entry", () => {
		// The repro: a parent with @indexName referencing a sub-projection
		// without one. Assembling from resolvers[].sdlFile alone leaves
		// `tags: [TagSearchDoc!]!` dangling — the fragment is emitted and
		// exported, only the manifest never named it.
		const manifest = JSON.parse(
			__test.generateGraphQLManifest(
				[petSearchDoc],
				[petResolverFile],
				undefined,
				undefined,
				__test.generateNestedTypeEntries([tagSearchDoc]),
			),
		);

		assert.equal(manifest.resolvers.length, 1);
		assert.equal(manifest.resolvers[0].projection, "PetSearchDoc");
		assert.deepEqual(manifest.nestedTypes, [
			{
				projection: "TagSearchDoc",
				sdlFile: "tag-search-doc.graphql",
				sdlModule: "schema/tag-search-doc",
			},
		]);
	});

	it("keeps nested types out of resolvers[] — they have no Query field or index", () => {
		const manifest = JSON.parse(
			__test.generateGraphQLManifest(
				[petSearchDoc],
				[petResolverFile],
				undefined,
				undefined,
				__test.generateNestedTypeEntries([tagSearchDoc]),
			),
		);

		assert.ok(
			!manifest.resolvers.some(
				(entry: { projection?: string }) => entry.projection === "TagSearchDoc",
			),
		);
	});

	it("omits nestedTypes entirely when no projection is nested-only", () => {
		const withUndefined = __test.generateGraphQLManifest(
			[petSearchDoc],
			[petResolverFile],
		);
		const withEmpty = __test.generateGraphQLManifest(
			[petSearchDoc],
			[petResolverFile],
			undefined,
			undefined,
			__test.generateNestedTypeEntries([]),
		);

		assert.equal(withUndefined, withEmpty);
		assert.ok(!("nestedTypes" in JSON.parse(withEmpty)));
	});
});

describe("generateRestManifestEntries (issue #134)", () => {
	const getPet = {
		fieldName: "getPet",
		typeName: "Query",
		httpMethod: "GET",
		path: "/pets/{petId}",
		pathParams: [{ name: "petId" }],
		queryParams: [],
		returnType: { kind: "Model", name: "Pet", properties: new Map() },
	} as unknown as ResolvedRestOperation;

	it("emits typeName/httpMethod/resourcePath/dataSource with HTTP default and no indexName", () => {
		const entries = __test.generateRestManifestEntries([getPet]);
		assert.deepEqual(entries, [
			{
				typeName: "Query",
				fieldName: "getPet",
				dataSource: "HTTP",
				httpMethod: "GET",
				resourcePath: "/pets/{petId}",
				mode: "monolithic",
				resolverFile: "Query.getPet.js",
				sdlFile: "pet.graphql",
			},
		]);
		assert.ok(!("indexName" in entries[0]));
	});

	it("uses rest.dataSourceName when configured", () => {
		const entries = __test.generateRestManifestEntries([getPet], "PetApi");
		assert.equal(entries[0].dataSource, "PetApi");
	});

	it("appends REST entries after OpenSearch entries in the manifest", () => {
		const projection = {
			projectionModel: { name: "PetSearchDoc" },
			sourceModel: { name: "Pet" },
			indexName: "pets_v1",
			fields: [],
		} as unknown as ResolvedProjection;
		const resolverFile = {
			queryFieldName: "searchPet",
			mode: "monolithic",
			fileName: "pet-search-doc-resolver.js",
			content: "",
			functions: [],
		};

		const manifest = JSON.parse(
			__test.generateGraphQLManifest(
				[projection],
				[resolverFile],
				undefined,
				__test.generateRestManifestEntries([getPet]),
			),
		);
		assert.equal(manifest.resolvers.length, 2);
		assert.equal(manifest.resolvers[0].projection, "PetSearchDoc");
		assert.equal(manifest.resolvers[1].fieldName, "getPet");
	});

	it("uses sdlFileName when provided (issue #142)", () => {
		const entries = __test.generateRestManifestEntries(
			[getPet],
			undefined,
			undefined,
			"all.graphql",
		);
		assert.equal(entries[0].sdlFile, "all.graphql");
	});

	it("leaves the manifest unchanged when no REST entries are passed", () => {
		const projection = {
			projectionModel: { name: "PetSearchDoc" },
			sourceModel: { name: "Pet" },
			indexName: "pets_v1",
			fields: [],
		} as unknown as ResolvedProjection;
		const resolverFile = {
			queryFieldName: "searchPet",
			mode: "monolithic",
			fileName: "pet-search-doc-resolver.js",
			content: "",
			functions: [],
		};

		const withUndefined = __test.generateGraphQLManifest(
			[projection],
			[resolverFile],
		);
		const withEmpty = __test.generateGraphQLManifest(
			[projection],
			[resolverFile],
			undefined,
			[],
		);
		assert.equal(withUndefined, withEmpty);
	});

	it("prepends resourcePathPrefix to resourcePath in manifest entries (issue #140)", () => {
		const entries = __test.generateRestManifestEntries(
			[getPet],
			undefined,
			"/api/v1",
		);
		assert.equal(entries[0].resourcePath, "/api/v1/pets/{petId}");
	});

	it("leaves resourcePath unchanged when no prefix given (default behavior)", () => {
		const entries = __test.generateRestManifestEntries([getPet]);
		assert.equal(entries[0].resourcePath, "/pets/{petId}");
	});
});

describe("validateResourcePathPrefix (issue #140)", () => {
	it("returns undefined when prefix is undefined", () => {
		assert.equal(__test.validateResourcePathPrefix(undefined), undefined);
	});

	it("returns undefined when prefix is empty string", () => {
		assert.equal(__test.validateResourcePathPrefix(""), undefined);
	});

	it("returns the prefix when valid", () => {
		assert.equal(__test.validateResourcePathPrefix("/api/v1"), "/api/v1");
	});

	it("throws when prefix does not start with /", () => {
		assert.throws(
			() => __test.validateResourcePathPrefix("api/v1"),
			/must start with "\/"/,
		);
	});

	it("throws when prefix ends with /", () => {
		assert.throws(
			() => __test.validateResourcePathPrefix("/api/v1/"),
			/must not end with "\/"/,
		);
	});
});

describe("isTemplateDeclaration", () => {
	it("returns true when model node has templateParameters", () => {
		const model = {
			node: { templateParameters: [{ name: "T" }] },
		} as unknown as Model;
		assert.equal(__test.isTemplateDeclaration(model), true);
	});

	it("returns false when model node has empty templateParameters", () => {
		const model = {
			node: { templateParameters: [] },
		} as unknown as Model;
		assert.equal(__test.isTemplateDeclaration(model), false);
	});

	it("returns false when model node has no templateParameters", () => {
		const model = {
			node: {},
		} as unknown as Model;
		assert.equal(__test.isTemplateDeclaration(model), false);
	});

	it("returns false when model has no node", () => {
		const model = {} as unknown as Model;
		assert.equal(__test.isTemplateDeclaration(model), false);
	});
});

const DEMOTION_CODE =
	"@kattebak/typespec-opensearch-emitter/search-projection-without-index-name";

describe("reportDemotedProjections (issue #157)", () => {
	async function resolveAll(source: string, names: string[]) {
		const runner = await createRunner();
		await runner.diagnose(source);
		const resolved = names.map((name) => {
			const model = runner.program.getGlobalNamespaceType().models.get(name);
			assert.ok(model, `fixture model ${name} must exist`);
			const projection = resolveProjectionModel(runner.program, model);
			assert.ok(projection);
			return projection;
		});
		return { runner, resolved };
	}

	const source = `
      model Widget {
        @searchable name: string;
      }

      @searchProjection
      model DemotedSearchDoc is SearchProjection<Widget> {}

      model UndecoratedSearchDoc is SearchProjection<Widget> {}
    `;

	it("warns when @searchProjection carries no @indexName", async () => {
		const { runner, resolved } = await resolveAll(source, ["DemotedSearchDoc"]);

		__test.reportDemotedProjections(runner.program, resolved);

		const relevant = runner.program.diagnostics.filter(
			(d) => d.code === DEMOTION_CODE,
		);
		assert.equal(relevant.length, 1);
		assert.equal(relevant[0].severity, "warning");
		assert.ok(relevant[0].message.includes("DemotedSearchDoc"));
		assert.ok(relevant[0].message.includes("@indexName"));
	});

	it("stays silent for a projection that never asked to be top-level", async () => {
		const { runner, resolved } = await resolveAll(source, [
			"UndecoratedSearchDoc",
		]);

		__test.reportDemotedProjections(runner.program, resolved);

		assert.equal(
			runner.program.diagnostics.filter((d) => d.code === DEMOTION_CODE).length,
			0,
		);
	});
});

// Issue #173 — the split ships fitting output for realistic projections, but a
// projection wide enough that even the fully split pipeline can't fit must fail
// compile, not emit an undeployable resolver that only breaks at AppSync
// CreateFunction. Two guards: any AppSync function file over the 32,768-byte
// code cap, and a pipeline over AppSync's 10-function-per-resolver limit.
const TOO_LARGE_CODE =
	"@kattebak/typespec-opensearch-emitter/resolver-function-too-large";
const TOO_MANY_CODE =
	"@kattebak/typespec-opensearch-emitter/pipeline-too-many-functions";

describe("assertResolverFilesFit (issue #173)", () => {
	// runner.program is inaccessible until a compile/diagnose runs; a trivial
	// source gives an empty program the guard can report onto.
	async function emptyProgram() {
		const runner = await createRunner();
		await runner.diagnose("model Noop {}");
		return runner.program;
	}

	function resolverFile(
		functions: { name: string; fileName: string; content: string }[],
		content = "// after-mapping\n",
	) {
		return {
			queryFieldName: "searchWidget",
			mode: "pipeline" as const,
			fileName: "widget-search-doc-resolver.js",
			content,
			functions: functions.map((fn) => ({
				...fn,
				dataSource: "NONE" as const,
			})),
		};
	}

	it("hard-errors when a generated function exceeds the 32,768-byte AppSync cap", async () => {
		const program = await emptyProgram();
		const oversized = "x".repeat(33_000);
		__test.assertResolverFilesFit(
			program,
			"WidgetSearchDoc",
			resolverFile([
				{
					name: "prepare-query-1",
					fileName: "widget-search-doc-fn-prepare-query-1.js",
					content: oversized,
				},
			]),
		);

		const relevant = program.diagnostics.filter(
			(d) => d.code === TOO_LARGE_CODE,
		);
		assert.equal(relevant.length, 1);
		assert.equal(relevant[0].severity, "error");
		assert.ok(
			relevant[0].message.includes("widget-search-doc-fn-prepare-query-1.js"),
		);
		assert.ok(relevant[0].message.includes("33000"));
	});

	it("hard-errors when the resolver-level file itself exceeds the cap", async () => {
		const program = await emptyProgram();
		__test.assertResolverFilesFit(
			program,
			"WidgetSearchDoc",
			resolverFile([], "y".repeat(40_000)),
		);
		assert.equal(
			program.diagnostics.filter((d) => d.code === TOO_LARGE_CODE).length,
			1,
		);
	});

	it("hard-errors when the split needs more than 10 pipeline functions", async () => {
		const program = await emptyProgram();
		const functions = Array.from({ length: 11 }, (_, i) => ({
			name: `prepare-query-${i}`,
			fileName: `widget-search-doc-fn-prepare-query-${i}.js`,
			content: "// small\n",
		}));
		__test.assertResolverFilesFit(
			program,
			"WidgetSearchDoc",
			resolverFile(functions),
		);

		const relevant = program.diagnostics.filter(
			(d) => d.code === TOO_MANY_CODE,
		);
		assert.equal(relevant.length, 1);
		assert.equal(relevant[0].severity, "error");
		assert.ok(relevant[0].message.includes("WidgetSearchDoc"));
		assert.ok(relevant[0].message.includes("11"));
	});

	it("stays silent when every function fits and the pipeline is within the function limit", async () => {
		const program = await emptyProgram();
		__test.assertResolverFilesFit(
			program,
			"WidgetSearchDoc",
			resolverFile([
				{
					name: "prepare-query",
					fileName: "widget-search-doc-fn-prepare-query.js",
					content: "// under cap\n",
				},
				{
					name: "search",
					fileName: "widget-search-doc-fn-search.js",
					content: "// under cap\n",
				},
			]),
		);
		assert.equal(
			program.diagnostics.filter(
				(d) => d.code === TOO_LARGE_CODE || d.code === TOO_MANY_CODE,
			).length,
			0,
		);
	});
});
