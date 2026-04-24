import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { isSearchable } from "./decorators.js";
import { resolveProjectionModel } from "./projection.js";
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

describe("projection resolution", () => {
	it("resolves only searchable fields and merges projection overrides", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Tag {
        @searchable label: string;
        hidden: string;
      }

      model Product {
        @searchable @keyword name: string;
        @searchable tags: Tag[];
        hidden: string;
      }

      @indexName("products_v1")
      model ProductSearchDoc is SearchProjection<Product> {
        @analyzer("edge_ngram") @boost(2.0)
        name: string;

        @nested
        tags: Tag[];
      }
    `);

		assert.equal(diagnostics.length, 0);

		const projectionModel = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projectionModel);

		const resolved = resolveProjectionModel(runner.program, projectionModel);
		assert.ok(resolved);

		assert.equal(resolved.sourceModel.name, "Product");
		assert.equal(resolved.indexName, "products_v1");
		assert.deepEqual(
			resolved.fields.map((x) => x.name),
			["name", "tags"],
		);

		const nameField = resolved.fields.find((x) => x.name === "name");
		assert.ok(nameField);
		assert.equal(nameField.keyword, true);
		assert.equal(nameField.analyzer, "edge_ngram");
		assert.equal(nameField.boost, 2);

		const tagsField = resolved.fields.find((x) => x.name === "tags");
		assert.ok(tagsField);
		assert.equal(tagsField.nested, true);
	});

	it("returns undefined for non projection model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
      }
    `);
		assert.equal(diagnostics.length, 0);

		const model = runner.program.getGlobalNamespaceType().models.get("Product");
		assert.ok(model);
		assert.equal(resolveProjectionModel(runner.program, model), undefined);
	});

	it("keeps non-searchable source fields excluded", async () => {
		const runner = await createRunner();
		await runner.compile(`
      model Product {
        @searchable name: string;
        hidden: string;
      }

      model ProductSearchDoc is SearchProjection<Product> {}
    `);

		const source = runner.program
			.getGlobalNamespaceType()
			.models.get("Product");
		assert.ok(source);
		const hidden = source.properties.get("hidden");
		assert.ok(hidden);
		assert.equal(isSearchable(runner.program, hidden), false);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);
		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		assert.deepEqual(
			resolved.fields.map((x) => x.name),
			["name"],
		);
	});

	it("emits diagnostic for projection field not on source model", async () => {
		const runner = await createRunner();
		const _diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
      }

      model ProductSearchDoc is SearchProjection<Product> {
        name: string;
        phantom: string;
      }
    `);

		// diagnose() only runs the compiler; we must invoke resolveProjectionModel
		// to trigger projection-level diagnostics.
		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);
		resolveProjectionModel(runner.program, projection);

		const relevant = runner.program.diagnostics.filter(
			(d) =>
				d.code ===
				"@kattebak/typespec-opensearch-emitter/projection-field-not-on-source",
		);
		assert.equal(relevant.length, 1);
		assert.ok(relevant[0].message.includes("phantom"));
	});

	it("emits diagnostic for projection field that exists on source but is not @searchable", async () => {
		const runner = await createRunner();
		const _diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
        hidden: string;
      }

      model ProductSearchDoc is SearchProjection<Product> {
        name: string;
        hidden: string;
      }
    `);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);
		resolveProjectionModel(runner.program, projection);

		const relevant = runner.program.diagnostics.filter(
			(d) =>
				d.code ===
				"@kattebak/typespec-opensearch-emitter/projection-field-not-on-source",
		);
		assert.equal(relevant.length, 1);
		assert.ok(relevant[0].message.includes("hidden"));
	});
});
