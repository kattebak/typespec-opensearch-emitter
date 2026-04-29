import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Type } from "@typespec/compiler";
import {
	buildSearchFilterShape,
	collectFilterables,
	hasFilterables,
	searchFilterTypeName,
} from "./filters.js";
import type { ResolvedProjection } from "./projection.js";

function makeProjection(
	overrides: Partial<{
		name: string;
		fields: ResolvedProjection["fields"];
	}> = {},
): ResolvedProjection {
	return {
		projectionModel: { name: overrides.name ?? "PetSearchDoc" },
		sourceModel: { name: "Pet" },
		indexName: "pets_v1",
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
		filterables: ResolvedProjection["fields"][0]["filterables"];
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
			overrides.type ?? ({ kind: "Scalar", name: "string" } as unknown as Type),
		filterables: overrides.filterables,
		subProjection: overrides.subProjection,
	} as unknown as ResolvedProjection["fields"][0];
}

describe("searchFilterTypeName", () => {
	it("strips SearchDoc and adds SearchFilter", () => {
		assert.equal(
			searchFilterTypeName("CounterpartySearchDoc"),
			"CounterpartySearchFilter",
		);
		assert.equal(searchFilterTypeName("PetSearchDoc"), "PetSearchFilter");
	});
});

describe("collectFilterables", () => {
	it("returns empty list when no filterables", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		assert.deepEqual(collectFilterables(projection), []);
	});

	it("expands range into four bound entries", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "rank",
					filterables: ["range"],
					type: { kind: "Scalar", name: "int32" } as unknown as Type,
				}),
			],
		});

		const entries = collectFilterables(projection);
		assert.equal(entries.length, 4);
		assert.deepEqual(
			entries.map((e) => e.inputFieldName),
			["rankGte", "rankLte", "rankGt", "rankLt"],
		);
		for (const entry of entries) {
			assert.equal(entry.kind, "range");
			assert.equal(entry.openSearchField, "rank");
			assert.equal(entry.nestedPath, undefined);
		}
	});

	it("emits term and term_negate as separate input fields", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term", "term_negate"],
				}),
			],
		});

		const entries = collectFilterables(projection);
		assert.deepEqual(
			entries.map((e) => `${e.inputFieldName}=${e.kind}`),
			["species=term", "speciesNot=term_negate"],
		);
	});

	it("appends .keyword for non-keyword text string fields", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "nickname",
					optional: true,
					filterables: ["exists"],
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
			],
		});
		const entries = collectFilterables(projection);
		assert.equal(entries[0].openSearchField, "nickname.keyword");
	});

	it("uses bare field for keyword fields", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term"],
				}),
			],
		});
		const entries = collectFilterables(projection);
		assert.equal(entries[0].openSearchField, "species");
	});

	it("threads nestedPath through @nested sub-projections", () => {
		const subProjection = {
			projectionModel: { name: "TagSearchDoc" },
			sourceModel: { name: "Tag" },
			indexName: "tags",
			fields: [
				makeField({
					name: "name",
					keyword: true,
					filterables: ["term", "term_negate"],
				}),
			],
		} as unknown as ResolvedProjection;

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

		const entries = collectFilterables(projection);
		assert.equal(entries.length, 2);
		for (const entry of entries) {
			assert.equal(entry.nestedPath, "tags");
			assert.equal(entry.openSearchField, "tags.name");
		}
	});
});

describe("hasFilterables", () => {
	it("returns false when no fields are filterable", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		assert.equal(hasFilterables(projection), false);
	});

	it("returns true when only nested sub-projection has filterables", () => {
		const subProjection = {
			projectionModel: { name: "TagSearchDoc" },
			sourceModel: { name: "Tag" },
			indexName: "tags",
			fields: [
				makeField({
					name: "name",
					keyword: true,
					filterables: ["term"],
				}),
			],
		} as unknown as ResolvedProjection;

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
		assert.equal(hasFilterables(projection), true);
	});
});

describe("buildSearchFilterShape", () => {
	it("returns undefined when no filterables", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		assert.equal(buildSearchFilterShape(projection), undefined);
	});

	it("emits leaves for term, term_negate, exists, range", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["term", "term_negate"],
				}),
				makeField({
					name: "nickname",
					optional: true,
					filterables: ["exists"],
				}),
				makeField({
					name: "rank",
					filterables: ["range"],
					type: { kind: "Scalar", name: "int32" } as unknown as Type,
				}),
			],
		});

		const shape = buildSearchFilterShape(projection);
		assert.ok(shape);
		assert.equal(shape.typeName, "PetSearchFilter");
		const inputNames = shape.nodes.map((n) => n.inputName);
		assert.deepEqual(inputNames, [
			"species",
			"speciesNot",
			"nicknameExists",
			"rankGte",
			"rankLte",
			"rankGt",
			"rankLt",
		]);
		const range = shape.nodes.filter((n) => n.kind === "range");
		assert.equal(range.length, 4);
	});

	it("emits a nested node + a separate sub-shape for @nested sub-projection", () => {
		const subProjection = {
			projectionModel: { name: "TagSearchDoc" },
			sourceModel: { name: "Tag" },
			indexName: "tags",
			fields: [
				makeField({
					name: "name",
					keyword: true,
					filterables: ["term", "term_negate"],
				}),
			],
		} as unknown as ResolvedProjection;

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

		const shape = buildSearchFilterShape(projection);
		assert.ok(shape);
		assert.equal(shape.nodes.length, 1);
		const nested = shape.nodes[0];
		assert.equal(nested.kind, "nested");
		assert.equal(nested.inputName, "tags");
		assert.equal(nested.path, "tags");
		assert.equal(nested.nestedTypeName, "TagSearchFilter");
		assert.equal(nested.children?.length, 2);

		assert.equal(shape.nestedShapes.length, 1);
		assert.equal(shape.nestedShapes[0].typeName, "TagSearchFilter");
	});

	it("inlines non-nested object sub-projections at the parent level", () => {
		const ownerSub = {
			projectionModel: { name: "OwnerSearchDoc" },
			sourceModel: { name: "Owner" },
			indexName: "owners",
			fields: [
				makeField({
					name: "name",
					keyword: true,
					filterables: ["term"],
				}),
			],
		} as unknown as ResolvedProjection;

		const projection = makeProjection({
			fields: [
				makeField({
					name: "owner",
					nested: false,
					subProjection: ownerSub,
					type: { kind: "Model" } as unknown as Type,
				}),
			],
		});

		const shape = buildSearchFilterShape(projection);
		assert.ok(shape);
		// owner.name shows up as a flat leaf, not under a nested node.
		assert.equal(shape.nodes.length, 1);
		assert.equal(shape.nodes[0].kind, "term");
		assert.equal(shape.nodes[0].inputName, "name");
		assert.equal(shape.nestedShapes.length, 0);
	});
});
