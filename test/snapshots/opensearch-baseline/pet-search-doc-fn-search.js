export function request(ctx) {
	return {
		operation: "GET",
		path: "/pets_v1/_search",
		params: { body: ctx.stash.queryBody },
	};
}

export function response(ctx) {
	return ctx.result;
}
