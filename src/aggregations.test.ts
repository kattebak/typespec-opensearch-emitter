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

const {
	aggregationFieldName,
	singularize,
	capitalize,
	isTextField,
	isArrayType,
} = __test;

const stringScalar = { kind: "Scalar", name: "string" } as unknown as Type;
const arrayOfString = {
	kind: "Model",
	name: "Array",
	indexer: { value: { kind: "Scalar", name: "string" } },
} as unknown as Type;
const arrayOfModel = {
	kind: "Model",
	name: "Array",
	indexer: { value: { kind: "Model" } },
} as unknown as Type;

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
		aggregations: unknown;
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
		aggregations: liftAggregations(overrides.aggregations),
		subProjection: overrides.subProjection,
	} as unknown as ResolvedProjection["fields"][0];
}

function liftAggregations(
	raw: unknown,
): ResolvedProjection["fields"][0]["aggregations"] {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	return raw.map((entry) =>
		typeof entry === "string" ? { kind: entry } : entry,
	) as ResolvedProjection["fields"][0]["aggregations"];
}

describe("aggregationFieldName", () => {
	it("emits byField for terms with plural drop on array fields", () => {
		assert.equal(
			aggregationFieldName("tags", "terms", undefined, true),
			"byTag",
		);
		assert.equal(
			aggregationFieldName("groups", "terms", undefined, true),
			"byGroup",
		);
		assert.equal(
			aggregationFieldName("locations", "terms", undefined, true),
			"byLocation",
		);
	});

	it("preserves singular field names ending in 's' on scalar fields", () => {
		assert.equal(aggregationFieldName("status", "terms"), "byStatus");
		assert.equal(aggregationFieldName("address", "terms"), "byAddress");
		assert.equal(aggregationFieldName("process", "terms"), "byProcess");
		assert.equal(aggregationFieldName("class", "terms"), "byClass");
	});

	it("emits uniqueFieldCount for cardinality on array fields", () => {
		assert.equal(
			aggregationFieldName("locations", "cardinality", undefined, true),
			"uniqueLocationCount",
		);
		assert.equal(
			aggregationFieldName("tags", "cardinality", undefined, true),
			"uniqueTagCount",
		);
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

	it("handles -ies plural on array fields", () => {
		assert.equal(
			aggregationFieldName("categories", "terms", undefined, true),
			"byCategory",
		);
	});

	it("emits <field><Sum|Avg|Min|Max> for numeric metric aggs", () => {
		assert.equal(aggregationFieldName("notional", "sum"), "notionalSum");
		assert.equal(aggregationFieldName("notional", "avg"), "notionalAvg");
		assert.equal(aggregationFieldName("rank", "min"), "rankMin");
		assert.equal(aggregationFieldName("rank", "max"), "rankMax");
	});

	it("prefixes nested-path numeric metric aggs with the singularized parent", () => {
		assert.equal(
			aggregationFieldName("notional", "sum", "trades"),
			"tradeNotionalSum",
		);
		assert.equal(
			aggregationFieldName("validTo", "max", "approvals"),
			"approvalValidToMax",
		);
	});

	it("emits by<Field>OverTime for date_histogram", () => {
		assert.equal(
			aggregationFieldName("validFrom", "date_histogram"),
			"byValidFromOverTime",
		);
	});

	it("emits by<Field>Range for range buckets", () => {
		assert.equal(aggregationFieldName("notional", "range"), "byNotionalRange");
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
					type: arrayOfString,
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
					type: arrayOfString,
				}),
			],
		});

		const entries = collectAggregations(projection);
		assert.equal(entries[0].openSearchField, "labels.keyword");
		assert.equal(entries[0].aggName, "byLabel");
	});

	it("preserves trailing 's' on singular scalar fields (status, address)", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "status",
					keyword: true,
					aggregations: ["terms"],
					type: stringScalar,
				}),
				makeField({
					name: "address",
					keyword: true,
					aggregations: ["terms"],
					type: stringScalar,
				}),
				makeField({
					name: "process",
					keyword: true,
					aggregations: ["terms"],
					type: stringScalar,
				}),
			],
		});

		const entries = collectAggregations(projection);
		assert.equal(entries.length, 3);
		assert.equal(entries[0].aggName, "byStatus");
		assert.equal(entries[1].aggName, "byAddress");
		assert.equal(entries[2].aggName, "byProcess");
	});

	it("drops trailing 's' on array (collection) fields", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					keyword: true,
					aggregations: ["terms"],
					type: arrayOfString,
				}),
			],
		});

		const entries = collectAggregations(projection);
		assert.equal(entries[0].aggName, "byTag");
	});
});

describe("collectAggregations with nested sub-projections", () => {
	function makeNestedTagSubProjection() {
		return {
			projectionModel: { name: "TagSearchDoc" },
			sourceModel: { name: "Tag" },
			indexName: "tags",
			fields: [
				makeField({
					name: "name",
					keyword: true,
					aggregations: ["terms", "cardinality"],
				}),
				makeField({
					name: "note",
					optional: true,
					aggregations: ["missing"],
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
			],
		} as unknown as ResolvedProjection;
	}

	it("threads nestedPath into entries inside @nested sub-projections", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					nested: true,
					subProjection: makeNestedTagSubProjection(),
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});

		const entries = collectAggregations(projection);

		assert.equal(entries.length, 3);

		const byTagName = entries.find((e) => e.aggName === "byTagName");
		assert.ok(byTagName);
		assert.equal(byTagName.kind, "terms");
		assert.equal(byTagName.nestedPath, "tags");
		assert.equal(byTagName.openSearchField, "tags.name");

		const uniqueTagNameCount = entries.find(
			(e) => e.aggName === "uniqueTagNameCount",
		);
		assert.ok(uniqueTagNameCount);
		assert.equal(uniqueTagNameCount.nestedPath, "tags");
		assert.equal(uniqueTagNameCount.openSearchField, "tags.name");

		const missingTagNoteCount = entries.find(
			(e) => e.aggName === "missingTagNoteCount",
		);
		assert.ok(missingTagNoteCount);
		assert.equal(missingTagNoteCount.nestedPath, "tags");
		assert.equal(missingTagNoteCount.openSearchField, "tags.note.keyword");
	});

	it("does not set nestedPath on object (non-nested) sub-projections", () => {
		const ownerSubProjection = {
			projectionModel: { name: "OwnerSearchDoc" },
			sourceModel: { name: "Owner" },
			indexName: "owners",
			fields: [
				makeField({
					name: "name",
					keyword: true,
					aggregations: ["terms"],
				}),
			],
		} as unknown as ResolvedProjection;

		const projection = makeProjection({
			fields: [
				makeField({
					name: "owner",
					nested: false,
					subProjection: ownerSubProjection,
					type: { kind: "Model" } as unknown as Type,
				}),
			],
		});

		const entries = collectAggregations(projection);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].nestedPath, undefined);
		assert.equal(entries[0].openSearchField, "name");
		assert.equal(entries[0].aggName, "byName");
	});

	it("hasAggregations returns true when only nested sub-projection has aggs", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					nested: true,
					subProjection: makeNestedTagSubProjection(),
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});

		assert.equal(hasAggregations(projection), true);
	});

	it("uses projectedName for nestedPath when @searchAs renames the field", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					projectedName: "labels",
					nested: true,
					subProjection: makeNestedTagSubProjection(),
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});

		const entries = collectAggregations(projection);
		const byTagName = entries.find((e) => e.aggName === "byLabelName");
		assert.ok(byTagName, "expected nestedPath prefix from projectedName");
		assert.equal(byTagName.nestedPath, "labels");
		assert.equal(byTagName.openSearchField, "labels.name");
	});
});

describe("isArrayType", () => {
	it("returns true for Model Array types", () => {
		assert.equal(isArrayType(arrayOfString), true);
		assert.equal(isArrayType(arrayOfModel), true);
	});

	it("returns false for scalar types", () => {
		assert.equal(isArrayType(stringScalar), false);
		assert.equal(
			isArrayType({ kind: "Scalar", name: "int32" } as unknown as Type),
			false,
		);
	});

	it("returns false for non-Array Model types", () => {
		assert.equal(
			isArrayType({ kind: "Model", name: "Address" } as unknown as Type),
			false,
		);
	});

	it("returns false for non-Model kinds", () => {
		assert.equal(isArrayType({ kind: "Enum" } as unknown as Type), false);
		assert.equal(isArrayType({ kind: "Boolean" } as unknown as Type), false);
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
