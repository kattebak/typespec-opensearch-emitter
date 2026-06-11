export function request(ctx) {
	return {
		operation: "GET",
		path: "/person_search_doc/_search",
		params: { body: ctx.stash.queryBody },
	};
}

export function response(ctx) {
	return ctx.result;
}
