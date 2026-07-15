import { util } from "@aws-appsync/utils";

export function request(ctx) {
	return {
		operation: "GET",
		path: "/pets_v1/_search",
		params: { body: ctx.stash.queryBody },
	};
}

export function response(ctx) {
	if (ctx.error) {
		return util.error(ctx.error.message, ctx.error.type, ctx.result);
	}
	if (!ctx.result || !ctx.result.hits) {
		const err = ctx.result ? ctx.result.error : null;
		const status = ctx.result ? ctx.result.status || ctx.result.statusCode : null;
		return util.error(
			(err && err.reason) || "OpenSearch search failed" + (status ? " with status " + status : "") + ": " + JSON.stringify(ctx.result),
			(err && err.type) || "OpenSearchError",
			ctx.result,
		);
	}
	return ctx.result;
}
