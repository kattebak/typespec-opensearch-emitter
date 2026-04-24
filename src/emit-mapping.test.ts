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

	it("maps enum field without @keyword as keyword", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      enum Status { Active, Pending, Archived }

      model Product {
        @searchable status: Status;
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

		assert.equal(parsed.mappings.properties.status.type, "keyword");
		assert.equal(parsed.mappings.properties.status.fields, undefined);
	});

	it("includes settings block when @indexSettings is provided", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Pet {
        @searchable name: string;
      }

      @indexSettings("{\\"analysis\\":{\\"analyzer\\":{\\"edge_ngram_autocomplete\\":{\\"type\\":\\"custom\\",\\"tokenizer\\":\\"edge_ngram_tokenizer\\",\\"filter\\":[\\"lowercase\\"]}}}}")
      model PetSearchDoc is SearchProjection<Pet> {
        @analyzer("edge_ngram_autocomplete") name: string;
      }
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("PetSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		const parsed = JSON.parse(emitted.content);

		assert.ok(parsed.settings);
		assert.ok(parsed.settings.analysis);
		assert.ok(parsed.settings.analysis.analyzer.edge_ngram_autocomplete);
		assert.equal(
			parsed.settings.analysis.analyzer.edge_ngram_autocomplete.type,
			"custom",
		);
		assert.ok(parsed.mappings.properties);
		assert.equal(
			parsed.mappings.properties.name.analyzer,
			"edge_ngram_autocomplete",
		);
	});

	it("does not include settings key when @indexSettings is not provided", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Pet {
        @searchable name: string;
      }

      model PetSearchDoc is SearchProjection<Pet> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("PetSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		const parsed = JSON.parse(emitted.content);

		assert.equal(parsed.settings, undefined);
		assert.ok(parsed.mappings.properties);
	});

	it("uses @ignoreAbove value on keyword sub-field", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable @ignoreAbove(1024) name: string;
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

		assert.equal(parsed.mappings.properties.name.type, "text");
		assert.deepEqual(parsed.mappings.properties.name.fields, {
			keyword: { type: "keyword", ignore_above: 1024 },
		});
	});

	it("nested field with sub-projection emits only sub-projection fields in properties", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Tag {
        @searchable @keyword name: string;
        @searchable createdAt: utcDateTime;
        internalId: string;
      }

      model TagSearchDoc is SearchProjection<Tag> {}

      model Pet {
        @searchable name: string;
        @searchable @nested tags: Tag[];
      }

      @indexName("pets_v1")
      model PetSearchDoc is SearchProjection<Pet> {
        tags: TagSearchDoc[];
      }
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("PetSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		const parsed = JSON.parse(emitted.content);

		const tags = parsed.mappings.properties.tags;
		assert.equal(tags.type, "nested");
		assert.deepEqual(Object.keys(tags.properties).sort(), [
			"createdAt",
			"name",
		]);
		assert.equal(tags.properties.name.type, "keyword");
		assert.equal(tags.properties.createdAt.type, "date");
		// internalId should NOT appear
		assert.equal(tags.properties.internalId, undefined);
	});

	it("@nested is honored on sub-projection fields", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Tag {
        @searchable @keyword name: string;
      }

      model TagSearchDoc is SearchProjection<Tag> {}

      model Pet {
        @searchable name: string;
        @searchable tags: Tag[];
      }

      model PetSearchDoc is SearchProjection<Pet> {
        @nested tags: TagSearchDoc[];
      }
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("PetSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		const parsed = JSON.parse(emitted.content);

		assert.equal(parsed.mappings.properties.tags.type, "nested");
	});

	it("defaults ignore_above to 256 without decorator", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Product {
        @searchable name: string;
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

		assert.deepEqual(parsed.mappings.properties.name.fields, {
			keyword: { type: "keyword", ignore_above: 256 },
		});
	});

	it("uses @searchAs renamed key in mapping output", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Person {
        @searchable givenName: string;
        @searchable @keyword status: string;
      }

      model PersonSearchDoc is SearchProjection<Person> {
        @searchAs("firstName") givenName: string;
      }
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

		// renamed field
		assert.ok(parsed.mappings.properties.firstName);
		assert.equal(parsed.mappings.properties.firstName.type, "text");
		// original name should not appear
		assert.equal(parsed.mappings.properties.givenName, undefined);
		// non-renamed field still uses original name
		assert.ok(parsed.mappings.properties.status);
	});

	it("mapping output includes spread fields with correct types", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Counterparty {
        @searchable @keyword name: string;
        @searchable @analyzer("edge_ngram") email: string;
        hidden: string;
      }

      model Wrapper {
        counterparty: Counterparty;
        @searchable score: float64;
      }

      model WrapperSearchDoc is SearchProjection<Wrapper> {
        ...Counterparty;
        score: float64;
      }
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("WrapperSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);
		const emitted = emitMapping(runner.program, resolved);
		const parsed = JSON.parse(emitted.content);

		assert.equal(parsed.mappings.properties.name.type, "keyword");
		assert.equal(parsed.mappings.properties.email.type, "text");
		assert.equal(parsed.mappings.properties.email.analyzer, "edge_ngram");
		assert.equal(parsed.mappings.properties.score.type, "double");
		assert.equal(parsed.mappings.properties.hidden, undefined);
	});
});
