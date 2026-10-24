import "@typespec/http";
import "@kattebak/typespec-opensearch-emitter";

using TypeSpec.Http;
using Kattebak.OpenSearch;

// Issue #206 — a union of models emits as a GraphQL union, and the resolver
// tags each value with __typename from its discriminator. `Settlement` mixes
// a model with a scalar and keeps the scalar mapping.
scalar DecimalAmount extends decimal;

model FieldValue<T> {
	kind: "Value";
	value: T;
}

model FieldNoData {
	kind: "NoData";
}

model FieldNotInSubscription {
	kind: "NotInSubscription";
}

union Field<T> {
	FieldValue<T>,
	FieldNoData,
	FieldNotInSubscription,
}

model CashSettlement {
	currency: string;
}

union Settlement {
	CashSettlement,
	string,
}

model Quote {
	quoteId: string;
	price: Field<DecimalAmount>;
	quantity: Field<int32>;
	history: Field<DecimalAmount>[];
	settlement: Settlement;
}

@route("/quotes")
namespace Quotes {
	@restResolver @get op getQuote(@path quoteId: string): Quote;
	@restResolver @get op listQuotes(): Quote[];
}
