import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { __test, emitMapping } from "./emit-mapping.js";
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

describe("mapping emitter", () => {
	it("emits OpenSearch mapping for projection", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Owner {
        @searchable @keyword name: string;
        email: string;
      }

      model Tag {
        @searchable name: string;
      }

      model Product {
        @searchable id: string;
        @searchable @keyword title: string;
        @searchable price: float64;
        @searchable releasedAt: plainDate;
        @searchable owner: Owner;
        @searchable @nested tags: Tag[];
      }

      model ProductSearchDoc is SearchProjection<Product> {
        @analyzer("edge_ngram") @boost(2)
        id: string;
      }
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		assert.equal(emitted.fileName, "product-search-doc-search-mapping.json");

		const parsed = JSON.parse(emitted.content);
		assert.equal(parsed.mappings.properties.title.type, "keyword");
		assert.equal(parsed.mappings.properties.id.type, "text");
		assert.equal(parsed.mappings.properties.id.analyzer, "edge_ngram");
		assert.equal(parsed.mappings.properties.id.boost, 2);
		assert.equal(parsed.mappings.properties.price.type, "double");
		assert.equal(parsed.mappings.properties.releasedAt.type, "date");
		assert.equal(parsed.mappings.properties.owner.type, "object");
		assert.deepEqual(Object.keys(parsed.mappings.properties.owner.properties), [
			"name",
		]);
		assert.equal(
			parsed.mappings.properties.owner.properties.name.type,
			"keyword",
		);
		assert.equal(parsed.mappings.properties.tags.type, "nested");
		assert.deepEqual(Object.keys(parsed.mappings.properties.tags.properties), [
			"name",
		]);
	});

	it("maps arrays of scalars as text (no @nested)", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable aliases: string[];
      }

      model ProductSearchDoc is SearchProjection<Product> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		const parsed = JSON.parse(emitted.content);

		assert.equal(parsed.mappings.properties.aliases.type, "text");
		assert.deepEqual(parsed.mappings.properties.aliases.fields, {
			keyword: { type: "keyword", ignore_above: 256 },
		});
	});

	it("mapString without overrides returns text with keyword sub-field", () => {
		const result = __test.mapString();
		assert.equal(result.type, "text");
		assert.deepEqual(result.fields, {
			keyword: { type: "keyword", ignore_above: 256 },
		});
	});

	it("mapString with only @keyword returns keyword type, no sub-fields", () => {
		const result = __test.mapString({ keyword: true });
		assert.equal(result.type, "keyword");
		assert.equal(result.fields, undefined);
	});

	it("maps boolean fields", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable active: boolean;
      }

      model ProductSearchDoc is SearchProjection<Product> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		const parsed = JSON.parse(emitted.content);

		assert.equal(parsed.mappings.properties.active.type, "boolean");
	});

	it("maps integer fields to long", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable quantity: int32;
      }

      model ProductSearchDoc is SearchProjection<Product> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		const parsed = JSON.parse(emitted.content);

		assert.equal(parsed.mappings.properties.quantity.type, "long");
	});

	it("combines analyzer and boost on same field", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
      }

      model ProductSearchDoc is SearchProjection<Product> {
        @analyzer("custom_analyzer") @boost(5)
        name: string;
      }
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		const parsed = JSON.parse(emitted.content);

		assert.equal(parsed.mappings.properties.name.type, "text");
		assert.equal(parsed.mappings.properties.name.analyzer, "custom_analyzer");
		assert.equal(parsed.mappings.properties.name.boost, 5);
		assert.deepEqual(parsed.mappings.properties.name.fields, {
			keyword: { type: "keyword", ignore_above: 256 },
		});
	});

	it("maps nested model with multiple searchable fields", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Address {
        @searchable street: string;
        @searchable @keyword city: string;
        @searchable zip: int32;
      }

      model Person {
        @searchable @nested addresses: Address[];
      }

      model PersonSearchDoc is SearchProjection<Person> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("PersonSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		const parsed = JSON.parse(emitted.content);

		assert.equal(parsed.mappings.properties.addresses.type, "nested");
		const addrProps = parsed.mappings.properties.addresses.properties;
		assert.deepEqual(Object.keys(addrProps).sort(), ["city", "street", "zip"]);
		assert.equal(addrProps.street.type, "text");
		assert.equal(addrProps.city.type, "keyword");
		assert.equal(addrProps.zip.type, "long");
	});
});
