import "@kattebak/typespec-opensearch-emitter";

using Kattebak.OpenSearch;

model Product {
	@searchable id: string;
	@searchable @keyword title: string;
	internalNotes: string;
}

@indexName("products_v1")
model ProductSearchDoc is SearchProjection<Product> {
	@analyzer("edge_ngram") title: string;
}
