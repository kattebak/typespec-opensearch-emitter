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
	internalNotes: string;
}

@indexName("pets_v1")
model PetSearchDoc is SearchProjection<Pet> {
	@analyzer("edge_ngram") @boost(2.0)
	name: string;

	@nested tags: TagSearchDoc[];
}

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

@searchInfer
model PersonSearchDoc is SearchProjection<Person> {}
