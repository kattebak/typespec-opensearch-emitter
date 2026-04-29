import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Type } from "@typespec/compiler";
import {
	__test,
	aggregationsTypeName,
	collectAggregations,
	hasAggregations,
} from "./aggregations.js";
import type { ResolvedProjection } from "./projection.js";

const { aggregationFieldName, singularize, capitalize, isTextField } = __test;

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
		aggregations: ResolvedProjection["fields"][0]["aggregations"];
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
		aggregations: overrides.aggregations,
		subProjection: overrides.subProjection,
	} as unknown as ResolvedProjection["fields"][0];
}

describe("aggregationFieldName", () => {
	it("emits byField for terms with plural drop", () => {
		assert.equal(aggregationFieldName("tags", "terms"), "byTag");
		assert.equal(aggregationFieldName("groups", "terms"), "byGroup");
		assert.equal(aggregationFieldName("locations", "terms"), "byLocation");
	});

	it("emits uniqueFieldCount for cardinality", () => {
		assert.equal(
			aggregationFieldName("locations", "cardinality"),
			"uniqueLocationCount",
		);
		assert.equal(aggregationFieldName("tags", "cardinality"), "uniqueTagCount");
	});

	it("emits missingFieldCount for missing", () => {
		assert.equal(
			aggregationFieldName("description", "missing"),
			"missingDescriptionCount",
		);
	});

	it("handles non-plural names", () => {
		assert.equal(aggregationFieldName("description", "terms"), "byDescription");
	});

	it("handles -ies plural", () => {
		assert.equal(aggregationFieldName("categories", "terms"), "byCategory");
	});
});

describe("singularize", () => {
	it("drops trailing s", () => {
		assert.equal(singularize("tags"), "tag");
	});

	it("converts -ies to -y", () => {
		assert.equal(singularize("categories"), "category");
	});

	it("preserves non-plurals", () => {
		assert.equal(singularize("description"), "description");
	});

	it("converts -es endings (sxz)", () => {
		assert.equal(singularize("statuses"), "status");
		assert.equal(singularize("boxes"), "box");
	});

	it("preserves -ss endings", () => {
		assert.equal(singularize("address"), "address");
		assert.equal(singularize("class"), "class");
	});
});

describe("capitalize", () => {
	it("uppercases first letter", () => {
		assert.equal(capitalize("tag"), "Tag");
	});

	it("handles empty string", () => {
		assert.equal(capitalize(""), "");
	});
});

describe("aggregationsTypeName", () => {
	it("strips SearchDoc and adds SearchAggregations", () => {
		assert.equal(
			aggregationsTypeName("CounterpartySearchDoc"),
			"CounterpartySearchAggregations",
		);
		assert.equal(aggregationsTypeName("PetSearchDoc"), "PetSearchAggregations");
	});

	it("handles names without SearchDoc suffix", () => {
		assert.equal(aggregationsTypeName("Pet"), "PetSearchAggregations");
	});
});

describe("hasAggregations", () => {
	it("returns true when any field has aggregations", () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({ name: "tags", aggregations: ["terms"] }),
			],
		});
		assert.equal(hasAggregations(projection), true);
	});

	it("returns false when no fields have aggregations", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		assert.equal(hasAggregations(projection), false);
	});

	it("returns false when aggregations array is empty", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "tags", aggregations: [] })],
		});
		assert.equal(hasAggregations(projection), false);
	});
});

describe("collectAggregations", () => {
	it("returns empty list when no aggregations", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		assert.deepEqual(collectAggregations(projection), []);
	});

	it("expands multi-kind aggregations into separate entries", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "locations",
					keyword: true,
					aggregations: ["terms", "cardinality"],
				}),
			],
		});

		const entries = collectAggregations(projection);
		assert.equal(entries.length, 2);
		assert.equal(entries[0].kind, "terms");
		assert.equal(entries[0].aggName, "byLocation");
		assert.equal(entries[1].kind, "cardinality");
		assert.equal(entries[1].aggName, "uniqueLocationCount");
	});

	it("appends .keyword for text string fields", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					aggregations: ["terms"],
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
			],
		});

		const entries = collectAggregations(projection);
		assert.equal(entries[0].openSearchField, "tags.keyword");
	});

	it("appends .keyword for arrays of strings", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					aggregations: ["terms"],
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Scalar", name: "string" } },
					} as unknown as Type,
				}),
			],
		});

		const entries = collectAggregations(projection);
		assert.equal(entries[0].openSearchField, "tags.keyword");
	});

	it("uses bare field name for keyword fields", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "species",
					keyword: true,
					aggregations: ["terms"],
				}),
			],
		});

		const entries = collectAggregations(projection);
		assert.equal(entries[0].openSearchField, "species");
	});

	it("uses bare field name for numeric fields", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "rank",
					aggregations: ["terms"],
					type: { kind: "Scalar", name: "int32" } as unknown as Type,
				}),
			],
		});

		const entries = collectAggregations(projection);
		assert.equal(entries[0].openSearchField, "rank");
	});

	it("uses projectedName when present", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					projectedName: "labels",
					aggregations: ["terms"],
				}),
			],
		});

		const entries = collectAggregations(projection);
		assert.equal(entries[0].openSearchField, "labels.keyword");
		assert.equal(entries[0].aggName, "byLabel");
	});
});

describe("isTextField", () => {
	it("returns false for keyword fields", () => {
		assert.equal(isTextField(makeField({ keyword: true })), false);
	});

	it("returns true for plain string scalar", () => {
		assert.equal(
			isTextField(
				makeField({
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
			),
			true,
		);
	});

	it("returns false for date scalars", () => {
		assert.equal(
			isTextField(
				makeField({
					type: { kind: "Scalar", name: "plainDate" } as unknown as Type,
				}),
			),
			false,
		);
	});
});
