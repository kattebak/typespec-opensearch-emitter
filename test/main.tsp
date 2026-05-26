import "@kattebak/typespec-opensearch-emitter";

using Kattebak.OpenSearch;

model Owner {
	@searchable @keyword name: string;
	email: string;
	phone?: string;
}

model Tag {
	@searchable @keyword @aggregatable("terms", "cardinality") @filterable("term", "term_negate") name: string;
	@searchable @aggregatable("missing") @filterable("exists") note?: string;
}

// Issue #121 — per-model directive override. With no `directives.default`
// configured at the emitter level, this projection alone gets the directive
// applied to its response-path types and Query field; the other three
// projections in this fixture stay bare.
@searchProjection
@graphqlDirectives("@aws_cognito_user_pools", "@aws_iam")
model TagSearchDoc is SearchProjection<Tag> {}

model Pet {
	@searchable id: string;
	@searchable name: string;
	@searchable @keyword @aggregatable("terms") @filterable("term", "term_negate") species: string;
	@searchable breed?: string;
	@searchable @filterable("range") birthDate: plainDate;
	@searchable @filterable("range") createdAt: utcDateTime;
	@searchable @nested tags: Tag[];
	@searchable owner: Owner;
	@searchable @aggregatable("terms", "cardinality") aliases: string[];
	@searchable @aggregatable("missing") @filterable("exists") nickname?: string;
	@searchable @filterable("range") rank: int32;
	@searchable stock: int64;
	@searchable score: float64;
	@searchable active: boolean;
	@searchable approvals: Approval[];
	internalNotes: string;
}

@searchProjection
@indexName("pets_v1")
model PetSearchDoc is SearchProjection<Pet> {
	// Issue #130 — prefix/match query the analyzed (edge_ngram) field, NOT the
	// `.keyword` sub-field, so partial / begins-with matching works.
	@analyzer("edge_ngram") @boost(2.0) @filterable("prefix", "match")
	name: string;

	@nested tags: TagSearchDoc[];

	// Issue #123 — nested-only reference. ApprovalSearchDoc has no
	// @searchProjection and so emits a stripped SDL fragment + doc type
	// (for use as an array element), but no Query field, no resolver, no
	// OS index, no manifest entry.
	approvals: ApprovalSearchDoc[];
}

model Approval {
	@searchable @keyword type: string;
	@searchable @keyword grantedBy: string;
}

model ApprovalSearchDoc is SearchProjection<Approval> {}

@searchProjection
model PetPublicSearchDoc is SearchProjection<Pet> {
	@keyword
	name: string;
}

@searchInfer
model Address {
	@keyword country: string;
	@keyword city: string;
}

model Person {
	@keyword id: string;
	@searchable address?: Address;
}

@searchProjection
@searchInfer
model PersonSearchDoc is SearchProjection<Person> {}
