import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { __test, emitDocType } from "./emit-doc-type.js";
import { resolveProjectionModel } from "./projection.js";
import { OpenSearchEmitterTestLibrary } from "./testing/index.js";

const { toKebabCase, toDocTypeFileName } = __test;

async function createRunner() {
	const host = await createTestHost({
		libraries: [OpenSearchEmitterTestLibrary],
	});

	return createTestWrapper(host, {
		autoImports: ["@kattebak/typespec-opensearch-emitter"],
		autoUsings: ["Kattebak.OpenSearch"],
	});
}

async function emitFor(source: string, modelName: string) {
	const runner = await createRunner();
	const diagnostics = await runner.diagnose(source);
	assert.equal(
		diagnostics.length,
		0,
		`Unexpected diagnostics: ${JSON.stringify(diagnostics)}`,
	);

	const projection = runner.program
		.getGlobalNamespaceType()
		.models.get(modelName);
	assert.ok(projection, `Model ${modelName} not found`);

	const resolved = resolveProjectionModel(runner.program, projection);
	assert.ok(resolved, `Could not resolve projection for ${modelName}`);

	return emitDocType(runner.program, resolved);
}

describe("toKebabCase", () => {
	it("converts PascalCase to kebab-case", () => {
		assert.equal(toKebabCase("PetSearchDoc"), "pet-search-doc");
	});

	it("converts camelCase to kebab-case", () => {
		assert.equal(toKebabCase("petSearchDoc"), "pet-search-doc");
	});

	it("handles single word", () => {
		assert.equal(toKebabCase("Pet"), "pet");
	});

	it("handles already kebab-case", () => {
		assert.equal(toKebabCase("pet-search-doc"), "pet-search-doc");
	});
});

describe("toDocTypeFileName", () => {
	it("strips -search-doc suffix and re-adds it with .ts", () => {
		assert.equal(toDocTypeFileName("PetSearchDoc"), "pet-search-doc.ts");
	});

	it("adds -search-doc.ts if not already present", () => {
		assert.equal(toDocTypeFileName("PetIndex"), "pet-index-search-doc.ts");
	});
});

describe("doc type emitter", () => {
	it("emits TypeScript interface for projection model", async () => {
		const emitted = await emitFor(
			`
			model Owner {
				@searchable name: string;
				email: string;
			}

			model Product {
				@searchable id: string;
				@searchable price: float64;
				@searchable owner: Owner;
				@searchable tags: string[];
			}

			model ProductSearchDoc is SearchProjection<Product> {}
			`,
			"ProductSearchDoc",
		);

		assert.equal(emitted.fileName, "product-search-doc.ts");
		assert.ok(emitted.content.includes("export interface ProductSearchDoc"));
		assert.ok(emitted.content.includes("\tid: string;"));
		assert.ok(emitted.content.includes("\tprice: number;"));
		assert.ok(emitted.content.includes("\towner:"));
		assert.ok(emitted.content.includes("\ttags: string[];"));
		assert.ok(!emitted.content.includes("email"));
	});

	it("emits empty body for model with no fields", async () => {
		const emitted = await emitFor(
			`
			model Empty {
				internalOnly: string;
			}

			model EmptySearchDoc is SearchProjection<Empty> {}
			`,
			"EmptySearchDoc",
		);

		assert.ok(emitted.content.includes("export interface EmptySearchDoc {}"));
	});

	it("emits optional fields with question mark", async () => {
		const emitted = await emitFor(
			`
			model Item {
				@searchable name: string;
				@searchable description?: string;
			}

			model ItemSearchDoc is SearchProjection<Item> {}
			`,
			"ItemSearchDoc",
		);

		assert.ok(emitted.content.includes("\tname: string;"));
		assert.ok(emitted.content.includes("\tdescription?: string;"));
	});

	it("renders scalar types correctly", async () => {
		const emitted = await emitFor(
			`
			model Widget {
				@searchable name: string;
				@searchable count: int32;
				@searchable bigCount: int64;
				@searchable score: float64;
				@searchable active: boolean;
				@searchable created: plainDate;
				@searchable updated: utcDateTime;
			}

			model WidgetSearchDoc is SearchProjection<Widget> {}
			`,
			"WidgetSearchDoc",
		);

		assert.ok(emitted.content.includes("\tname: string;"));
		assert.ok(emitted.content.includes("\tcount: number;"));
		assert.ok(emitted.content.includes("\tbigCount: number;"));
		assert.ok(emitted.content.includes("\tscore: number;"));
		assert.ok(emitted.content.includes("\tactive: boolean;"));
		assert.ok(emitted.content.includes("\tcreated: string;"));
		assert.ok(emitted.content.includes("\tupdated: string;"));
	});

	it("renders nested inline object with correct indentation", async () => {
		const emitted = await emitFor(
			`
			model Address {
				@searchable city: string;
				@searchable zip: string;
				country: string;
			}

			model Person {
				@searchable name: string;
				@searchable address: Address;
			}

			model PersonSearchDoc is SearchProjection<Person> {}
			`,
			"PersonSearchDoc",
		);

		const expected = [
			"export interface PersonSearchDoc {",
			"\tname: string;",
			"\taddress: {",
			"\t\tcity: string;",
			"\t\tzip: string;",
			"\t};",
			"}",
		].join("\n");

		assert.equal(emitted.content, `${expected}\n`);
	});

	it("renders deeply nested objects with correct indentation", async () => {
		const emitted = await emitFor(
			`
			model Street {
				@searchable name: string;
			}

			model Address {
				@searchable street: Street;
				@searchable city: string;
			}

			model Person {
				@searchable name: string;
				@searchable address: Address;
			}

			model PersonSearchDoc is SearchProjection<Person> {}
			`,
			"PersonSearchDoc",
		);

		const expected = [
			"export interface PersonSearchDoc {",
			"\tname: string;",
			"\taddress: {",
			"\t\tstreet: {",
			"\t\t\tname: string;",
			"\t\t};",
			"\t\tcity: string;",
			"\t};",
			"}",
		].join("\n");

		assert.equal(emitted.content, `${expected}\n`);
	});

	it("renders array of inline objects with correct indentation", async () => {
		const emitted = await emitFor(
			`
			model Tag {
				@searchable label: string;
			}

			model Item {
				@searchable tags: Tag[];
			}

			model ItemSearchDoc is SearchProjection<Item> {}
			`,
			"ItemSearchDoc",
		);

		const expected = [
			"export interface ItemSearchDoc {",
			"\ttags: {",
			"\t\tlabel: string;",
			"\t}[];",
			"}",
		].join("\n");

		assert.equal(emitted.content, `${expected}\n`);
	});

	it("renders inline object with no searchable fields as empty object", async () => {
		const emitted = await emitFor(
			`
			model Meta {
				internal: string;
			}

			model Item {
				@searchable name: string;
				@searchable meta: Meta;
			}

			model ItemSearchDoc is SearchProjection<Item> {}
			`,
			"ItemSearchDoc",
		);

		assert.ok(emitted.content.includes("\tmeta: {};"));
	});

	it("renders string array", async () => {
		const emitted = await emitFor(
			`
			model Item {
				@searchable aliases: string[];
			}

			model ItemSearchDoc is SearchProjection<Item> {}
			`,
			"ItemSearchDoc",
		);

		assert.ok(emitted.content.includes("\taliases: string[];"));
	});

	it("excludes non-searchable fields", async () => {
		const emitted = await emitFor(
			`
			model Item {
				@searchable visible: string;
				hidden: string;
			}

			model ItemSearchDoc is SearchProjection<Item> {}
			`,
			"ItemSearchDoc",
		);

		assert.ok(emitted.content.includes("\tvisible: string;"));
		assert.ok(!emitted.content.includes("hidden"));
	});

	it("renders full interface matching snapshot for complex model", async () => {
		const emitted = await emitFor(
			`
			model Tag {
				@searchable @keyword name: string;
			}

			model Owner {
				@searchable @keyword name: string;
				email: string;
			}

			model Pet {
				@searchable id: string;
				@searchable name: string;
				@searchable @keyword species: string;
				@searchable breed?: string;
				@searchable birthDate: plainDate;
				@searchable @nested tags: Tag[];
				@searchable owner: Owner;
				@searchable aliases: string[];
				@searchable rank: int32;
				@searchable active: boolean;
				internalNotes: string;
			}

			@indexName("pets_v1")
			model PetSearchDoc is SearchProjection<Pet> {
				@analyzer("edge_ngram") @boost(2.0) name: string;
			}
			`,
			"PetSearchDoc",
		);

		const expected = [
			"export interface PetSearchDoc {",
			"\tid: string;",
			"\tname: string;",
			"\tspecies: string;",
			"\tbreed?: string;",
			"\tbirthDate: string;",
			"\ttags: {",
			"\t\tname: string;",
			"\t}[];",
			"\towner: {",
			"\t\tname: string;",
			"\t};",
			"\taliases: string[];",
			"\trank: number;",
			"\tactive: boolean;",
			"}",
		].join("\n");

		assert.equal(emitted.content, `${expected}\n`);
	});

	it("renders sub-projection field as named type reference", async () => {
		const emitted = await emitFor(
			`
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
			`,
			"PetSearchDoc",
		);

		assert.ok(emitted.content.includes("tags: TagSearchDoc[];"));
		assert.ok(
			emitted.content.includes(
				'import type { TagSearchDoc } from "./tag-search-doc.js";',
			),
		);
	});

	it("renders enum field as string literal union", async () => {
		const emitted = await emitFor(
			`
			enum Status { Active, Pending, Archived }

			model Product {
				@searchable status: Status;
			}

			model ProductSearchDoc is SearchProjection<Product> {}
			`,
			"ProductSearchDoc",
		);

		assert.ok(
			emitted.content.includes('status: "Active" | "Pending" | "Archived";'),
		);
	});

	it("renders enum with explicit values using those values", async () => {
		const emitted = await emitFor(
			`
			enum Priority { Low: "low", Medium: "medium", High: "high" }

			model Task {
				@searchable priority: Priority;
			}

			model TaskSearchDoc is SearchProjection<Task> {}
			`,
			"TaskSearchDoc",
		);

		assert.ok(emitted.content.includes('priority: "low" | "medium" | "high";'));
	});

	it("uses @searchAs renamed property in TypeScript interface", async () => {
		const emitted = await emitFor(
			`
			model Person {
				@searchable givenName: string;
				@searchable age: int32;
			}

			model PersonSearchDoc is SearchProjection<Person> {
				@searchAs("firstName") givenName: string;
			}
			`,
			"PersonSearchDoc",
		);

		assert.ok(emitted.content.includes("firstName: string;"));
		assert.ok(!emitted.content.includes("givenName"));
		assert.ok(emitted.content.includes("age: number;"));
	});

	it("TypeScript interface includes spread fields", async () => {
		const emitted = await emitFor(
			`
			model Counterparty {
				@searchable @keyword name: string;
				@searchable email: string;
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
			`,
			"WrapperSearchDoc",
		);

		assert.ok(emitted.content.includes("name: string;"));
		assert.ok(emitted.content.includes("email: string;"));
		assert.ok(emitted.content.includes("score: number;"));
		assert.ok(!emitted.content.includes("hidden"));
	});

	it("honours @searchAs on nested model properties", async () => {
		const emitted = await emitFor(
			`
			model Person {
				@searchable @searchAs("firstName") givenName: string;
				@searchable @searchAs("lastName") familyName: string;
			}

			model Contact {
				@searchable contactId: string;
				@searchable person?: Person;
			}

			model ContactSearchDoc is SearchProjection<Contact> {}
			`,
			"ContactSearchDoc",
		);

		assert.ok(
			emitted.content.includes("firstName"),
			"should use renamed firstName",
		);
		assert.ok(
			emitted.content.includes("lastName"),
			"should use renamed lastName",
		);
		assert.ok(
			!emitted.content.includes("givenName"),
			"should not use original givenName",
		);
		assert.ok(
			!emitted.content.includes("familyName"),
			"should not use original familyName",
		);
	});
});
