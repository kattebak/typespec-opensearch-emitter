import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "@typespec/compiler";
import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { __test } from "./emitter.js";
import type { ResolvedProjection } from "./projection.js";
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
		const projections = [
			{
				projectionModel: { name: "ProductSearchDoc" },
				sourceModel: { name: "Product" },
				indexName: "product_search_doc",
				fields: [],
			},
		] as unknown as ResolvedProjection[];

		const result = JSON.parse(
			__test.generatePackageJson("@my/pkg", "1.0.0", projections),
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

	it("sorts mapping exports alphabetically", () => {
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

		const result = JSON.parse(
			__test.generatePackageJson("@my/pkg", "2.0.0", projections),
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

	it("includes graphql artifact exports when graphqlProjections provided", () => {
		const projections = [
			{
				projectionModel: { name: "ProductSearchDoc" },
				sourceModel: { name: "Product" },
				indexName: "product_search_doc",
				fields: [],
			},
		] as unknown as ResolvedProjection[];

		const result = JSON.parse(
			__test.generatePackageJson("@my/pkg", "1.0.0", projections, projections),
		);

		assert.equal(
			result.exports["./graphql-resolvers.json"],
			"./graphql-resolvers.json",
		);
		assert.equal(
			result.exports["./graphql-resolvers.js"],
			"./graphql-resolvers.js",
		);
		assert.equal(
			result.exports["./product-search-doc.graphql"],
			"./product-search-doc.graphql",
		);
		assert.equal(
			result.exports["./product-search-doc-resolver.js"],
			"./product-search-doc-resolver.js",
		);
	});

	it("sorts all exports including graphql artifacts", () => {
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

		const result = JSON.parse(
			__test.generatePackageJson("@my/pkg", "2.0.0", projections, projections),
		);
		const exportKeys = Object.keys(result.exports).filter((k) => k !== ".");

		const sortedKeys = [...exportKeys].sort();
		assert.deepEqual(exportKeys, sortedKeys);
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
