import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Type } from "@typespec/compiler";
import { emitGraphQLResolver } from "./emit-graphql-resolver.js";
import type { ResolvedProjection } from "./projection.js";

function makeProjection(
	overrides: Partial<{
		name: string;
		indexName: string;
		fields: ResolvedProjection["fields"];
	}> = {},
): ResolvedProjection {
	return {
		projectionModel: { name: overrides.name ?? "PetSearchDoc" },
		sourceModel: { name: "Pet" },
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
		type:
			overrides.type ??
			({
				kind: "Scalar",
				name: "string",
			} as unknown as Type),
		subProjection: overrides.subProjection,
	} as unknown as ResolvedProjection["fields"][0];
}

const defaultOptions = {
	defaultPageSize: 20,
	maxPageSize: 100,
	trackTotalHitsUpTo: 10000,
};

describe("emitGraphQLResolver", () => {
	it("generates resolver file with correct name", () => {
		const projection = makeProjection({ fields: [] });
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.equal(result.fileName, "pet-search-doc-resolver.js");
		assert.equal(result.queryFieldName, "searchPet");
	});

	it("includes index name in request path", () => {
		const projection = makeProjection({
			indexName: "pets_v1",
			fields: [],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes("/pets_v1/_search"));
	});

	it("includes text fields in multi_match", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" }), makeField({ name: "breed" })],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('"name","breed"'));
	});

	it("includes keyword fields in filter logic", () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "species", keyword: true }),
				makeField({ name: "status", keyword: true }),
			],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('"species","status"'));
	});

	it("excludes nested and sub-projection fields from text fields", () => {
		const subProjection = {
			projectionModel: { name: "TagSearchDoc" },
		} as unknown as ResolvedProjection;

		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({ name: "tags", nested: true }),
				makeField({ name: "owner", subProjection }),
			],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('["name"]'));
	});

	it("respects custom page size and track_total_hits options", () => {
		const projection = makeProjection({ fields: [] });
		const result = emitGraphQLResolver(projection, {
			defaultPageSize: 10,
			maxPageSize: 50,
			trackTotalHitsUpTo: 5000,
		});

		assert.ok(result.content.includes("args.first || 10"));
		assert.ok(result.content.includes("50)"));
		assert.ok(result.content.includes("track_total_hits: 5000"));
	});

	it("uses projectedName for field references", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name", projectedName: "displayName" })],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('"displayName"'));
		assert.ok(!result.content.includes('"name"'));
	});

	it("has no import statements except aws-appsync/utils", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		const result = emitGraphQLResolver(projection, defaultOptions);

		const imports = result.content
			.split("\n")
			.filter((l) => l.startsWith("import "));
		assert.equal(imports.length, 1);
		assert.ok(imports[0].includes("@aws-appsync/utils"));
	});

	it("sorts by _score desc then _id asc", () => {
		const projection = makeProjection({ fields: [] });
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes('{ _score: "desc" }'));
		assert.ok(result.content.includes('{ _id: "asc" }'));
	});

	it("uses search_after for cursor pagination", () => {
		const projection = makeProjection({ fields: [] });
		const result = emitGraphQLResolver(projection, defaultOptions);

		assert.ok(result.content.includes("search_after"));
		assert.ok(result.content.includes("base64Decode"));
		assert.ok(result.content.includes("base64Encode"));
	});
});
