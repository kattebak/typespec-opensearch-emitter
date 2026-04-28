import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "@typespec/compiler";
import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { __test } from "./emitter.js";
import type { ResolvedProjection } from "./projection.js";
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
			declaration: true,
			outDir: ".",
		});
		assert.deepEqual(result.include, ["index.ts", "product-search-doc.ts"]);
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
