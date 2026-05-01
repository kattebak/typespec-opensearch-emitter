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

/**
 * Mirrors how buildVirtualSubProjection in projection.ts assembles a
 * sub-projection for a nested struct: projectionModel and sourceModel
 * reference the same model object. emit-graphql-sdl uses that identity
 * to distinguish virtual struct sub-projections (which need a `type X`
 * block emitted in the parent SDL) from explicit SearchProjection<T>
 * sub-projections (which already have their own SDL file).
 */
function makeVirtualSubProjection(
	name: string,
	fields: ResolvedProjection["fields"],
): ResolvedProjection {
	const model = { name } as unknown as ResolvedProjection["projectionModel"];
	return {
		projectionModel: model,
		sourceModel: model,
		indexName: "",
		fields,
	} as unknown as ResolvedProjection;
}

function makeField(
	overrides: Partial<{
		name: string;
		projectedName: string;
		keyword: boolean;
		nested: boolean;
		optional: boolean;
		searchable: boolean;
		analyzer: string;
		boost: number;
		type: Type;
		aggregations: unknown;
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
		searchable: overrides.searchable ?? true,
		analyzer: overrides.analyzer,
		boost: overrides.boost,
		type:
			overrides.type ?? ({ kind: "Scalar", name: "string" } as unknown as Type),
		aggregations: liftAggregations(overrides.aggregations),
		filterables: overrides.filterables,
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

	it("excludes non-searchable filter-only fields from the response object type", () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "name" }),
				makeField({
					name: "counterpartyId",
					keyword: true,
					searchable: false,
					filterables: ["term"],
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		const objectTypeBlock = result.content.split("\n\n")[0];
		assert.ok(objectTypeBlock.includes("name: String!"));
		assert.ok(
			!objectTypeBlock.includes("counterpartyId"),
			"filter-only field must not appear on the response object type",
		);
		// But it should still appear in the SearchFilter input.
		assert.ok(result.content.includes("counterpartyId: String"));
	});

	it("excludes non-searchable @keyword fields from the legacy <Type>Filter input", () => {
		const projection = makeProjection({
			fields: [
				makeField({ name: "species", keyword: true }),
				makeField({
					name: "counterpartyId",
					keyword: true,
					searchable: false,
					filterables: ["term"],
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		const filterBlock = result.content.match(
			/input PetSearchDocFilter \{[^}]*\}/,
		)?.[0];
		assert.ok(filterBlock, "PetSearchDocFilter block should exist");
		assert.ok(filterBlock.includes("species: String"));
		assert.ok(
			!filterBlock.includes("counterpartyId"),
			"non-searchable @keyword fields must not appear in <Type>Filter",
		);
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

	it("emits `type <Name>` block for nested struct virtual sub-projections referenced from response shape", () => {
		// Issue: when a projection references a nested struct (e.g. Address)
		// via @searchInfer auto-recursion, only `input AddressSearchFilter`
		// was emitted — no `type Address`. AppSync schema validation rejects
		// the assembled SDL because the response field type is undefined.
		const addressVirtual = makeVirtualSubProjection("Address", [
			makeField({
				name: "country",
				type: { kind: "Scalar", name: "string" } as unknown as Type,
			}),
			makeField({
				name: "city",
				type: { kind: "Scalar", name: "string" } as unknown as Type,
			}),
		]);

		const projection = makeProjection({
			fields: [
				makeField({
					name: "location",
					subProjection: addressVirtual,
					optional: true,
					type: { kind: "Model", name: "Address" } as unknown as Type,
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(
			result.content.includes("location: Address\n"),
			"response field references nested type by name",
		);
		assert.ok(
			result.content.match(/^type Address \{/m),
			"emits `type Address { ... }` block",
		);
		assert.ok(result.content.includes("country: String!"));
		assert.ok(result.content.includes("city: String!"));
	});

	it("emits nested struct types only once when referenced via multiple paths", () => {
		const addressVirtual = makeVirtualSubProjection("Address", [
			makeField({
				name: "country",
				type: { kind: "Scalar", name: "string" } as unknown as Type,
			}),
		]);

		const personVirtual = makeVirtualSubProjection("PersonRecord", [
			makeField({
				name: "address",
				subProjection: addressVirtual,
				optional: true,
				type: { kind: "Model", name: "Address" } as unknown as Type,
			}),
		]);

		const projection = makeProjection({
			fields: [
				makeField({
					name: "location",
					subProjection: addressVirtual,
					optional: true,
					type: { kind: "Model", name: "Address" } as unknown as Type,
				}),
				makeField({
					name: "person",
					subProjection: personVirtual,
					optional: true,
					type: { kind: "Model", name: "PersonRecord" } as unknown as Type,
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		const addressBlocks = result.content.match(/^type Address \{/gm) ?? [];
		assert.equal(
			addressBlocks.length,
			1,
			"Address must be emitted exactly once even when reachable via two paths",
		);
		assert.ok(result.content.match(/^type PersonRecord \{/m));
	});

	it("recurses into nested struct sub-projections to emit transitively referenced struct types", () => {
		const addressVirtual = makeVirtualSubProjection("Address", [
			makeField({
				name: "country",
				type: { kind: "Scalar", name: "string" } as unknown as Type,
			}),
		]);

		const personVirtual = makeVirtualSubProjection("PersonRecord", [
			makeField({
				name: "address",
				subProjection: addressVirtual,
				optional: true,
				type: { kind: "Model", name: "Address" } as unknown as Type,
			}),
		]);

		const projection = makeProjection({
			fields: [
				makeField({
					name: "person",
					subProjection: personVirtual,
					optional: true,
					type: { kind: "Model", name: "PersonRecord" } as unknown as Type,
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(
			result.content.match(/^type PersonRecord \{/m),
			"directly-referenced nested type emitted",
		);
		assert.ok(
			result.content.match(/^type Address \{/m),
			"transitively-referenced nested type emitted",
		);
	});

	it("does not emit `type <Name>` block for explicit SearchProjection<T> sub-projections", () => {
		// Explicit SearchProjection<T> models (e.g. TagSearchDoc) get their
		// own SDL file via emitGraphQLSdl. Re-emitting the type block from
		// every parent projection would create duplicates after assembly.
		const explicitSub = makeProjection({
			name: "TagSearchDoc",
			sourceName: "Tag",
		});
		const projection = makeProjection({
			fields: [
				makeField({
					name: "tags",
					nested: true,
					subProjection: explicitSub,
					type: {
						kind: "Model",
						name: "Array",
						indexer: { value: { kind: "Model" } },
					} as unknown as Type,
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		const tagBlocks = result.content.match(/^type TagSearchDoc \{/gm) ?? [];
		assert.equal(
			tagBlocks.length,
			0,
			"explicit projection sub-types must not be re-emitted in the parent SDL",
		);
	});
});

describe("emitGraphQLSdl aggregations", () => {
	it("omits aggregations type and connection field when no aggregations", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(!result.content.includes("TermBucket"));
		assert.ok(!result.content.includes("SearchAggregations"));
		assert.ok(!result.content.includes("aggregations:"));
	});

	it("emits TermBucket and aggregations type when fields are aggregatable", () => {
		const projection = makeProjection({
			name: "CounterpartySearchDoc",
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
				makeField({
					name: "description",
					optional: true,
					aggregations: ["missing"],
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("type TermBucket {"));
		assert.ok(result.content.includes("key: String!"));
		assert.ok(result.content.includes("count: Int!"));
		assert.ok(result.content.includes("type CounterpartySearchAggregations {"));
		assert.ok(result.content.includes("byTag: [TermBucket!]!"));
		assert.ok(result.content.includes("missingDescriptionCount: Int!"));
		assert.ok(
			result.content.includes("aggregations: CounterpartySearchAggregations!"),
		);
	});

	it("emits DateHistogramBucket for date_histogram", () => {
		const projection = makeProjection({
			name: "TradeSearchDoc",
			fields: [
				makeField({
					name: "validFrom",
					type: { kind: "Scalar", name: "utcDateTime" } as unknown as Type,
					aggregations: [
						{ kind: "date_histogram", options: { interval: "month" } },
					],
				}),
			],
		});
		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("type DateHistogramBucket {"));
		assert.ok(
			result.content.includes("keyAsString: String"),
			"DateHistogramBucket must surface keyAsString so callers can read OS's formatted date string",
		);
		assert.ok(
			result.content.includes("byValidFromOverTime: [DateHistogramBucket!]!"),
		);
	});

	it("emits RangeBucket for range buckets", () => {
		const projection = makeProjection({
			name: "TradeSearchDoc",
			fields: [
				makeField({
					name: "notional",
					type: { kind: "Scalar", name: "float64" } as unknown as Type,
					aggregations: [
						{
							kind: "range",
							options: {
								ranges: [{ to: 1000 }, { from: 1000 }],
							},
						},
					],
				}),
			],
		});
		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("type RangeBucket {"));
		assert.ok(result.content.includes("from: Float"));
		assert.ok(result.content.includes("to: Float"));
		assert.ok(result.content.includes("byNotionalRange: [RangeBucket!]!"));
	});

	it("emits per-agg bucket type with hits field when terms has topHits", () => {
		const projection = makeProjection({
			name: "TradeSearchDoc",
			fields: [
				makeField({
					name: "counterpartyId",
					keyword: true,
					aggregations: [{ kind: "terms", options: { topHits: 5 } }],
				}),
			],
		});
		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("type ByCounterpartyIdBucket {"));
		assert.ok(result.content.includes("hits: [TradeSearchDoc!]!"));
		assert.ok(
			result.content.includes("byCounterpartyId: [ByCounterpartyIdBucket!]!"),
		);
	});

	it("emits per-agg bucket type when terms has sub-aggregations", () => {
		const projection = makeProjection({
			name: "TradeSearchDoc",
			fields: [
				makeField({
					name: "counterpartyId",
					keyword: true,
					aggregations: [
						{
							kind: "terms",
							options: {
								sub: { latestValidTo: { kind: "max", field: "validTo" } },
							},
						},
					],
				}),
			],
		});
		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("type ByCounterpartyIdBucket {"));
		assert.ok(result.content.includes("latestValidTo: Float"));
		assert.ok(
			result.content.includes("byCounterpartyId: [ByCounterpartyIdBucket!]!"),
		);
	});

	it("emits nullable Float for sum/avg/min/max numeric metric aggs", () => {
		const projection = makeProjection({
			name: "TradeSearchDoc",
			fields: [
				makeField({
					name: "notional",
					type: { kind: "Scalar", name: "float64" } as unknown as Type,
					aggregations: ["sum", "avg", "min", "max"],
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("type TradeSearchAggregations {"));
		assert.ok(result.content.includes("notionalSum: Float\n"));
		assert.ok(result.content.includes("notionalAvg: Float\n"));
		assert.ok(result.content.includes("notionalMin: Float\n"));
		assert.ok(result.content.includes("notionalMax: Float"));
		// Must not be non-null — OpenSearch returns null when no docs match.
		assert.ok(!result.content.includes("notionalSum: Float!"));
	});

	it("emits nested-aware aggregation field names from sub-projections", () => {
		const subProjection = {
			projectionModel: { name: "TagSearchDoc" },
			sourceModel: { name: "Tag" },
			indexName: "tags",
			fields: [
				makeField({
					name: "name",
					keyword: true,
					aggregations: ["terms", "cardinality"],
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

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("type PetSearchAggregations {"));
		assert.ok(result.content.includes("byTagName: [TermBucket!]!"));
		assert.ok(result.content.includes("uniqueTagNameCount: Int!"));
		assert.ok(result.content.includes("aggregations: PetSearchAggregations!"));
	});

	it("emits both terms and cardinality aggregation fields", () => {
		const projection = makeProjection({
			fields: [
				makeField({
					name: "locations",
					keyword: true,
					aggregations: ["terms", "cardinality"],
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("byLocation: [TermBucket!]!"));
		assert.ok(result.content.includes("uniqueLocationCount: Int!"));
	});
});

describe("emitGraphQLSdl SearchFilter input", () => {
	it("omits SearchFilter when no @filterable fields", () => {
		const projection = makeProjection({
			fields: [makeField({ name: "name" })],
		});
		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(!result.content.includes("SearchFilter"));
	});

	it("emits each <Type>SearchFilter input at most once even when reachable via multiple paths (issue #103)", () => {
		// Construct a shape where the same nested filter type is reachable
		// via two different parent fields; without dedup the SDL emits two
		// `input AddressSearchFilter { ... }` blocks.
		const addressSub = {
			projectionModel: { name: "AddressSearchDoc" },
			sourceModel: { name: "Address" },
			indexName: "addresses",
			fields: [
				makeField({
					name: "country",
					keyword: true,
					filterables: ["term"],
				}),
			],
		} as unknown as ResolvedProjection;

		const projection = makeProjection({
			name: "CounterpartySearchDoc",
			fields: [
				makeField({
					name: "homeAddress",
					subProjection: addressSub,
					type: { kind: "Model" } as unknown as Type,
				}),
				makeField({
					name: "billingAddress",
					subProjection: addressSub,
					type: { kind: "Model" } as unknown as Type,
				}),
			],
		});

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		const addressInputCount = (
			result.content.match(/^input AddressSearchFilter \{/gm) ?? []
		).length;
		assert.equal(
			addressInputCount,
			1,
			"AddressSearchFilter must be declared exactly once in the SDL",
		);
	});

	it("emits term, term_negate, exists, range fields with proper suffixes", () => {
		const projection = makeProjection({
			name: "PetSearchDoc",
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

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("input PetSearchFilter {"));
		assert.ok(result.content.includes("species: String"));
		assert.ok(result.content.includes("speciesNot: String"));
		assert.ok(result.content.includes("nicknameExists: Boolean"));
		assert.ok(result.content.includes("rankGte: Int"));
		assert.ok(result.content.includes("rankLte: Int"));
		assert.ok(result.content.includes("rankGt: Int"));
		assert.ok(result.content.includes("rankLt: Int"));
	});

	it("emits SortDirection, <Type>SortField enum, and <Type>SortInput when fields are sortable", () => {
		const projection = makeProjection({
			name: "PetSearchDoc",
			fields: [
				makeField({
					name: "name",
					keyword: true,
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
				makeField({
					name: "rank",
					type: { kind: "Scalar", name: "int32" } as unknown as Type,
				}),
				makeField({
					name: "notes",
					type: { kind: "Scalar", name: "string" } as unknown as Type,
				}),
			],
		});
		// Mark name + rank sortable but not notes.
		projection.fields[0].sortable = true;
		projection.fields[1].sortable = true;
		projection.fields[2].sortable = false;

		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("enum SortDirection {"));
		assert.ok(result.content.includes("  ASC"));
		assert.ok(result.content.includes("  DESC"));
		assert.ok(result.content.includes("enum PetSortField {"));
		assert.ok(
			result.content.match(
				/enum PetSortField \{[\s\S]*name[\s\S]*rank[\s\S]*\}/,
			),
		);
		assert.ok(
			!result.content.match(/enum PetSortField \{[\s\S]*notes[\s\S]*\}/),
		);
		assert.ok(result.content.includes("input PetSortInput {"));
		assert.ok(result.content.includes("field: PetSortField!"));
		assert.ok(result.content.includes("direction: SortDirection!"));
	});

	it("omits sort types when no fields are sortable", () => {
		const projection = makeProjection({
			name: "PetSearchDoc",
			fields: [makeField({ name: "name" })],
		});
		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(!result.content.includes("SortDirection"));
		assert.ok(!result.content.includes("SortField"));
		assert.ok(!result.content.includes("SortInput"));
	});

	it("emits terms (multi-value) filter as a list scalar input", () => {
		const projection = makeProjection({
			name: "PetSearchDoc",
			fields: [
				makeField({
					name: "species",
					keyword: true,
					filterables: ["terms"],
				}),
				makeField({
					name: "rank",
					filterables: ["terms"],
					type: { kind: "Scalar", name: "int32" } as unknown as Type,
				}),
			],
		});
		const result = emitGraphQLSdl(dummyProgram, projection, defaultOptions);
		assert.ok(result.content.includes("speciesIn: [String!]"));
		assert.ok(result.content.includes("rankIn: [Int!]"));
	});

	it("emits a separate SearchFilter input for @nested sub-projection", () => {
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
			name: "PetSearchDoc",
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
		assert.ok(result.content.includes("input PetSearchFilter {"));
		assert.ok(result.content.includes("tags: TagSearchFilter"));
		assert.ok(result.content.includes("input TagSearchFilter {"));
		assert.ok(result.content.includes("name: String"));
		assert.ok(result.content.includes("nameNot: String"));
	});

	it("uses projectedName for nested input field name", () => {
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
					projectedName: "labels",
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
		assert.ok(result.content.includes("labels: TagSearchFilter"));
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
