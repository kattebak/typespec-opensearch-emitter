import "@kattebak/typespec-opensearch-emitter";

using Kattebak.OpenSearch;

model Owner {
	@searchable @keyword name: string;
	email: string;
	phone?: string;
}

model Tag {
	@searchable @keyword name: string;
}

model Pet {
	@searchable id: string;
	@searchable name: string;
	@searchable @keyword @aggregatable("terms") species: string;
	@searchable breed?: string;
	@searchable birthDate: plainDate;
	@searchable createdAt: utcDateTime;
	@searchable @nested tags: Tag[];
	@searchable owner: Owner;
	@searchable @aggregatable("terms", "cardinality") aliases: string[];
	@searchable @aggregatable("missing") nickname?: string;
	@searchable rank: int32;
	@searchable stock: int64;
	@searchable score: float64;
	@searchable active: boolean;
	internalNotes: string;
}

@indexName("pets_v1")
model PetSearchDoc is SearchProjection<Pet> {
	@analyzer("edge_ngram") @boost(2.0)
	name: string;
}

model PetPublicSearchDoc is SearchProjection<Pet> {
	@keyword
	name: string;
}
