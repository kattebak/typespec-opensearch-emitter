import { util } from "@aws-appsync/utils";

export function request(ctx) {
	return {};
}

export function response(ctx) {
	if (ctx.error) {
		return util.error(ctx.error.message, ctx.error.type);
	}

	const parsedBody = ctx.prev.result;
	if (!parsedBody || !parsedBody.hits) {
		const err = parsedBody ? parsedBody.error : null;
		const status = parsedBody ? parsedBody.status || parsedBody.statusCode : null;
		return util.error(
			(err && err.reason) || "OpenSearch search failed" + (status ? " with status " + status : "") + ": " + JSON.stringify(parsedBody),
			(err && err.type) || "OpenSearchError",
			null,
			parsedBody,
		);
	}
	const hits = parsedBody.hits.hits;
	const totalHits = parsedBody.hits.total.value;
	const args = ctx.args;
	const size = Math.min(args.first || 20, 100);

	const hasNextPage = hits.length > size;
	const page = hits.slice(0, size);
	const edges = [];
	for (const hit of page) {
		const node = normalizeNode(hit._source);
		if (node == null) {
			console.log("dropping unrepresentable document", hit._id);
		} else {
			edges.push({ node, cursor: util.base64Encode(JSON.stringify(hit.sort)) });
		}
	}
	const _a = parsedBody.aggregations || {};
	return {
		edges,
		totalCount: totalHits,
		aggregations: {
			byName: (_a.byName?.buckets ?? []).map((b) => ({ key: b.key, count: b.doc_count })),
			uniqueNameCount: _a.uniqueNameCount?.value ?? 0,
			missingNoteCount: _a.missingNoteCount?.doc_count ?? 0,
		},
		pageInfo: {
			hasNextPage,
			endCursor: page.length > 0 ? util.base64Encode(JSON.stringify(page[page.length - 1].sort)) : null,
		},
	};
}

const DOC_SPEC = [[[],[],["name"]]];

function normalizeNode(node) {
	if (node == null) return null;
	for (const level of DOC_SPEC) {
		let containers = [node];
		for (const segment of level[0]) {
			const next = [];
			for (const container of containers) {
				const value = container[segment[0]];
				if (value != null) {
					if (segment[1]) {
						for (const item of value) {
							if (item != null) next.push(item);
						}
					} else {
						next.push(value);
					}
				}
			}
			containers = next;
		}
		for (const container of containers) {
			for (const name of level[1]) {
				if (container[name] == null) container[name] = [];
			}
			for (const name of level[2]) {
				if (container[name] == null) return null;
			}
		}
	}
	return node;
}
