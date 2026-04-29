import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Scalar, Type, Union } from "@typespec/compiler";
import {
	__test,
	emitGraphQLSdl,
	toGraphQLQueryFieldName,
} from "./emit-graphql-sdl.js";
import type { ResolvedProjection } from "./projection.js";

function makeProjection(
	overrides: Partial<{
		name: string;
		sourceName: string;
		indexName: string;
		fields: ResolvedProjection["fields"];
	}> = {},
): ResolvedProjection {
	return {
		projectionModel: { name: overrides.name ?? "PetSearchDoc" },
		sourceModel: { name: overrides.sourceName ?? "Pet" },
		indexName: overrides.indexName ?? "pets_v1",
		fields: overrides.fields ?? [],
	} as unknown as ResolvedProjection;
}

function makeField(
	overrides: Partial<{
		name: string;
		projectedName: string;
		keyword: boolean;
		nested: boolean;
		optional: boolean;
		analyzer: string;
		boost: number;
		type: Type;
		subProjection: ResolvedProjection;
	}> = {},
) {
	return {
		name: overrides.name ?? "field",
		projectedName: overrides.projectedName,
		keyword: overrides.keyword ?? false,
		nested: overrides.nested ?? false,
		optional: overrides.optional ?? false,
		searchable: true,
		analyzer: overrides.analyzer,
		boost: overrides.boost,
		type:
			overrides.type ?? ({ kind: "Scalar", name: "string" } as unknown as Type),
		subProjection: overrides.subProjection,
	} as unknown as ResolvedProjection["fields"][0];
}

const dummyProgram = {} as never;
const defaultOptions = { defaultPageSize: 20, maxPageSize: 100 };

describe("emitGraphQLSdl", () => {
	it("generates object type from projection fields", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "name",
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
				makeField({
					name: "rank",
					type: { kind: "Scalar", name: "int32" } as unknown as Type,
				}),
				makeField({
					name: "active",
					type: { kind: "Scalar", name: "boolean" } as unknown as Type,
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);

		assert.equal(result.fileName, "pet-search-doc.graphql");
		assert.ok(result.content.includes("type PetSearchDoc {"));
		assert.ok(result.content.includes("name: String!"));
		assert.ok(result.content.includes("rank: Int!"));
		assert.ok(result.content.includes("active: Boolean!"));
	});

	it("marks optional fields as nullable", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "breed",
					optional: true,
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("breed: String\n"));
		assert.ok(!result.content.includes("breed: String!"));
	});

	it("generates filter input for keyword fields", () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "species", keyword: true }),
				makeField({ name: "name" }),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("input PetSearchDocFilter {"));
		assert.ok(result.content.includes("  species: String"));
	});

	it("omits filter input when no keyword fields", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(!result.content.includes("Filter"));
	});

	it("generates connection types", () => {
		const projection = makeProjection({ fields: [] });

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("type PetSearchDocConnection {"));
		assert.ok(result.content.includes("edges: [PetSearchDocEdge!]!"));
		assert.ok(result.content.includes("pageInfo: PageInfo!"));
		assert.ok(result.content.includes("totalCount: Int!"));
		assert.ok(result.content.includes("type PetSearchDocEdge {"));
		assert.ok(result.content.includes("node: PetSearchDoc!"));
		assert.ok(result.content.includes("cursor: String!"));
		assert.ok(result.content.includes("type PageInfo {"));
	});

	it("uses projectedName in output type", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name", projectedName: "displayName" })],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("displayName: String!"));
		assert.ok(!result.content.includes("  name:"));
	});

	it("renders sub-projection as nested type reference", () => {
		const subProjection = makeProjection({ name: "TagSearchDoc" });
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					nested: true,
					subProjection,
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("tags: [TagSearchDoc!]!"));
	});
});

describe("toGraphQLQueryFieldName", () => {
	it("strips SearchDoc suffix and prefixes with search", () => {
		assert.equal(toGraphQLQueryFieldName("PetSearchDoc"), "searchPet");
		assert.equal(toGraphQLQueryFieldName("ProductSearchDoc"), "searchProduct");
	});

	it("handles names without SearchDoc suffix", () => {
		assert.equal(toGraphQLQueryFieldName("Inventory"), "searchInventory");
	});
});
