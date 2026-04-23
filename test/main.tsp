import "@kattebak/typespec-opensearch-emitter";

model ProductDocument {
	id: string;
	title: string;
	price: float64;
}
