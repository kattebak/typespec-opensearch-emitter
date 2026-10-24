import { util } from "@aws-appsync/utils";

const BASE_HEADERS = (ctx) => ({
	"Content-Type": "application/json",
});

export function request(ctx) {
	return {
		method: "GET",
		resourcePath: "/quotes",
		params: { headers: BASE_HEADERS(ctx) },
	};
}

export function response(ctx) {
	const result = mapResponse(ctx);
	for (const item of result ?? []) {
		tagQuote(item);
	}
	return result;
}

function mapResponse(ctx) {
	const { statusCode, body } = ctx.result;
	const parsed = body ? JSON.parse(body) : null;
	if (statusCode >= 200 && statusCode < 300) return parsed;
	if (statusCode === 409) util.error(parsed?.message ?? body, "ConflictError");
	if (statusCode === 403) util.error(parsed?.message ?? body, "ForbiddenError");
	util.error(parsed?.message ?? body, `Http${statusCode}`, parsed);
}

function tagDecimalAmountField(value) {
	if (value === undefined || value === null) return;
	if (value.kind === "Value") {
		value.__typename = "DecimalAmountFieldValue";
	}
	if (value.kind === "NoData") {
		value.__typename = "FieldNoData";
	}
	if (value.kind === "NotInSubscription") {
		value.__typename = "FieldNotInSubscription";
	}
}

function tagInt32Field(value) {
	if (value === undefined || value === null) return;
	if (value.kind === "Value") {
		value.__typename = "Int32FieldValue";
	}
	if (value.kind === "NoData") {
		value.__typename = "FieldNoData";
	}
	if (value.kind === "NotInSubscription") {
		value.__typename = "FieldNotInSubscription";
	}
}

function tagQuote(value) {
	if (value === undefined || value === null) return;
	tagDecimalAmountField(value.price);
	tagInt32Field(value.quantity);
	for (const item of value.history ?? []) {
		tagDecimalAmountField(item);
	}
}
