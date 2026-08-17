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
	const droppedIds = [];
	for (const hit of page) {
		const node = normalizeNode(hit._source);
		if (node == null) {
			droppedIds.push(hit._id);
		} else {
			edges.push({ node, cursor: util.base64Encode(JSON.stringify(hit.sort)) });
		}
	}
	if (droppedIds.length > 0) {
		console.log("SearchDocumentDropped", JSON.stringify({ droppedCount: droppedIds.length, documentIds: droppedIds }));
		util.appendError(droppedIds.length + " of " + page.length + " documents on this page could not be returned: fields the schema requires are missing from the index. Reindex the listed documents to restore the page.", "UnrepresentableDocumentError", null, { droppedCount: droppedIds.length, documentIds: droppedIds });
	}
	const _a = parsedBody.aggregations || {};
	return {
		edges,
		totalCount: totalHits - droppedIds.length,
		aggregations: {
			bySpecies: (_a.bySpecies?.buckets ?? []).map((b) => ({ key: b.key, count: b.doc_count })),
			byAlias: (_a.byAlias?.buckets ?? []).map((b) => ({ key: b.key, count: b.doc_count })),
			uniqueAliasCount: _a.uniqueAliasCount?.value ?? 0,
			missingNicknameCount: _a.missingNicknameCount?.doc_count ?? 0,
		},
		pageInfo: {
			hasNextPage,
			endCursor: page.length > 0 ? util.base64Encode(JSON.stringify(page[page.length - 1].sort)) : null,
		},
	};
}

function NF(containers, lists, values) {
	for (const container of containers) {
		for (const name of lists) {
			if (container[name] == null) container[name] = [];
		}
		for (const name of values) {
			if (container[name] == null) return false;
		}
	}
	return true;
}

function normalizeNode(node) {
	if (node == null) return null;
	if (!NF([node], ["tags","aliases","categories","approvals","bankAccountApprovals"], ["id","name","species","birthDate","createdAt","owner","feedingTime","walkDuration","rank","stock","score","active"])) return null;
	return node;
}
