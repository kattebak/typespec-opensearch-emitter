import "@kattebak/typespec-opensearch-emitter";

using Kattebak.OpenSearch;

model Trade {
	@searchable @keyword tradeId: string;
	@searchable @keyword @aggregatable("terms") desk: string;
	@searchable @keyword @aggregatable("terms", #{ size: 500 }) counterpartyId: string;

	@searchable
	@keyword
	@aggregatable("terms", #{ size: 40, sub: #{ largestNotional: #{ kind: "max", field: "notional" } } })
	book: string;

	@searchable @keyword @aggregatable("terms", #{ size: 5, topHits: 2 }) trader: string;
	@searchable notional: float64;
	@searchable @aggregatable("date_histogram", #{ interval: "day" }) tradedAt: utcDateTime;
}

@searchProjection
@indexName("trades_v1")
model TradeSearchDoc is SearchProjection<Trade> {}
