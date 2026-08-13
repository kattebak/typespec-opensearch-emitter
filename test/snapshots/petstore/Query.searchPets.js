import { util } from "@aws-appsync/utils";

const BASE_HEADERS = (ctx) => ({
	"Content-Type": "application/json",
	"x-user-id": ctx.identity.resolverContext.userId,
});

export function request(ctx) {
	return {
		method: "GET",
		resourcePath: `/pets/search${queryString(ctx)}`,
		params: { headers: BASE_HEADERS(ctx) },
	};
}

export function response(ctx) {
	return mapResponse(ctx);
}

function queryString(ctx) {
	const parts = [];
	appendEach(parts, "status", ctx.args.status);
	append(parts, "name", ctx.args.name);
	return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function append(parts, name, value) {
	if (value === undefined || value === null) return;
	parts.push(`${name}=${util.urlEncode(`${value}`)}`);
}

function appendEach(parts, name, values) {
	if (values === undefined || values === null) return;
	for (const value of values) append(parts, name, value);
}

function mapResponse(ctx) {
	const { statusCode, body } = ctx.result;
	const parsed = body ? JSON.parse(body) : null;
	if (statusCode >= 200 && statusCode < 300) return parsed;
	if (statusCode === 409) util.error(parsed?.message ?? body, "ConflictError");
	if (statusCode === 403) util.error(parsed?.message ?? body, "ForbiddenError");
	util.error(parsed?.message ?? body, `Http${statusCode}`, parsed);
}
