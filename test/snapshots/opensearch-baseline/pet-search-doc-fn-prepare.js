import { util } from "@aws-appsync/utils";
const FILTER_SPEC = [{b:"name",f:"name",k:"pm"}, {b:"species",f:"species",k:"tn"}, {b:"birthDate",f:"birthDate",k:"r"}, {b:"createdAt",f:"createdAt",k:"r"}, {i:"tags",k:"nested",p:"tags",c:[{b:"name",f:"tags.name",k:"tn"}, {b:"note",f:"tags.note.keyword",k:"e"}]}, {b:"nickname",f:"nickname.keyword",k:"e"}, {b:"rank",f:"rank",k:"r"}];

const AGG_SPEC = [{n:"bySpecies",a:{ terms: { field: "species", size: 10 } }}, {n:"byAlias",a:{ terms: { field: "aliases.keyword", size: 10 } }}, {n:"uniqueAliasCount",a:{ cardinality: { field: "aliases.keyword" } }}, {n:"missingNicknameCount",a:{ missing: { field: "nickname.keyword" } }}, {n:"byTagName",g:"_tags",p:"tags",a:{ terms: { field: "tags.name", size: 10 } }}, {n:"uniqueTagNameCount",g:"_tags",p:"tags",a:{ cardinality: { field: "tags.name" } }}, {n:"missingTagNoteCount",g:"_tags",p:"tags",a:{ missing: { field: "tags.note.keyword" } }}];

export function request(ctx) {
	const args = ctx.args;
	const size = Math.min(args.first || 20, 100);
	const searchAfter = args.after ? JSON.parse(util.base64Decode(args.after)) : undefined;

	const query = buildQuery(args.query, args.filter, args.searchFilter);
	const sort = buildSort(args.sortBy);

	const body = {
		size: size + 1,
		track_total_hits: 10000,
		sort,
		query,
	};

	if (searchAfter) {
		body.search_after = searchAfter;
	}
	const aggs = buildAggs(ctx.info.selectionSetList);
	if (aggs) {
		body.aggs = aggs;
	}

	ctx.stash.queryBody = body;
	return { payload: null };
}

export function response(ctx) {
	return ctx.result;
}

function buildAggs(selectionSetList) {
	// A first segment under `aggregations/` naming no AGG_SPEC entry is an
	// alias, whose target is not recoverable here — send every aggregation
	// rather than none.
	let aliased = false;
	for (const path of selectionSetList) {
		if (path.indexOf("aggregations/") === 0) {
			const rest = path.substring(13);
			const slash = rest.indexOf("/");
			const name = slash < 0 ? rest : rest.substring(0, slash);
			let declared = false;
			for (const spec of AGG_SPEC) {
				if (spec.n === name) declared = true;
			}
			if (!declared && name !== "__typename") aliased = true;
		}
	}
	// `null` means nothing was requested, and the request omits `aggs` entirely.
	const aggs = {};
	let requested = false;
	for (const spec of AGG_SPEC) {
		if (aliased || selectionSetList.indexOf("aggregations/" + spec.n) >= 0) {
			requested = true;
			if (spec.g) {
				const group = aggs[spec.g] || { nested: { path: spec.p }, aggs: {} };
				group.aggs[spec.n] = spec.a;
				aggs[spec.g] = group;
			} else {
				aggs[spec.n] = spec.a;
			}
		}
	}
	return requested ? aggs : null;
}

const TEXT_FIELDS = ["id","name","breed","nickname"];
const NESTED_TEXT_GROUPS = [["tags",["tags.note"]]];

function NQ(path, fields, queryText) {
	return { nested: { path, score_mode: "max", query: { multi_match: { query: queryText, fields, type: "best_fields", lenient: true } } } };
}

function buildQuery(queryText, filter, searchFilter) {
	const musts = [];
	const filters = [];
	const mustNots = [];

	if (queryText) {
		const shoulds = [];
		if (TEXT_FIELDS.length > 0) {
			shoulds.push({ multi_match: { query: queryText, fields: TEXT_FIELDS, type: "best_fields", lenient: true } });
		}
		for (const group of NESTED_TEXT_GROUPS) {
			shoulds.push(NQ(group[0], group[1], queryText));
		}
		musts.push({
			bool: {
				should: shoulds,
				minimum_should_match: 1,
			},
		});
	}

	const keywordFields = ["species"];
	if (filter) {
		for (const field of keywordFields) {
			if (filter[field] != null) {
				filters.push({ term: { [field]: filter[field] } });
			}
		}
	}

	if (searchFilter) {
		applyFilterSpec(FILTER_SPEC, searchFilter, filters, mustNots);
	}

	if (musts.length === 0 && filters.length === 0 && mustNots.length === 0) {
		return { match_all: {} };
	}

	return {
		bool: {
			...(musts.length > 0 ? { must: musts } : {}),
			...(filters.length > 0 ? { filter: filters } : {}),
			...(mustNots.length > 0 ? { must_not: mustNots } : {}),
		},
	};
}

const TEXT_SORT_FIELDS = [];

function buildSort(sortBy) {
	const fallback = [{ _score: "desc" }, { _id: "asc" }];
	if (!sortBy || sortBy.length === 0) {
		return fallback;
	}
	const out = [];
	for (const entry of sortBy) {
		if (entry && entry.field) {
			const direction = entry.direction === "ASC" ? "asc" : "desc";
			// OpenSearch refuses to sort on `text` fields. The emit-mapping
			// layer always adds a `.keyword` subfield for sortable text
			// fields, so target that subfield at runtime.
			const target = TEXT_SORT_FIELDS.indexOf(entry.field) >= 0
				? entry.field + ".keyword"
				: entry.field;
			out.push({ [target]: direction });
		}
	}
	out.push({ _id: "asc" });
	return out;
}

function applyFilterSpec(rootSpec, rootInput, rootOutFilters, rootOutMustNots) {
	if (!rootSpec || !rootInput) return;

	const procSlots = [null,null];
	const finSlots = [null];
	procSlots[0] = {
		spec: rootSpec,
		input: rootInput,
		outFilters: rootOutFilters,
		outMustNots: rootOutMustNots,
	};
	let procHead = 0;
	let procTail = 1;
	let finTail = 0;

	for (const _slot of procSlots) {
		if (procHead < procTail) {
			const item = procSlots[procHead];
			procHead = procHead + 1;
			const spec = item.spec;
			const input = item.input;
			const outFilters = item.outFilters;
			const outMustNots = item.outMustNots;

			for (const node of spec) {
				const value = input[node.i];
				if (node.k === "nested") {
					if (value != null) {
						const childFilters = [];
						const childMustNots = [];
						if (procTail + 1 > procSlots.length) {
							util.error(
								"applyFilterSpec exceeded fixed work-slot capacity; SearchFilter shape too deep for APPSYNC_JS function",
							);
						}
						if (finTail + 1 > finSlots.length) {
							util.error(
								"applyFilterSpec exceeded fixed finalize-slot capacity; SearchFilter shape too deep for APPSYNC_JS function",
							);
						}
						procSlots[procTail] = {
							spec: node.c,
							input: value,
							outFilters: childFilters,
							outMustNots: childMustNots,
						};
						procTail = procTail + 1;
						finSlots[finTail] = {
							path: node.p,
							childFilters,
							childMustNots,
							parentFilters: outFilters,
							parentMustNots: outMustNots,
						};
						finTail = finTail + 1;
					}
				} else if (node.k === "object") {
					if (value != null) {
						if (procTail + 1 > procSlots.length) {
							util.error(
								"applyFilterSpec exceeded fixed work-slot capacity; SearchFilter shape too deep for APPSYNC_JS function",
							);
						}
						procSlots[procTail] = {
							spec: node.c,
							input: value,
							outFilters,
							outMustNots,
						};
						procTail = procTail + 1;
					}
				} else if (node.k === "nested_exists") {
					if (value != null) {
						const nestedClause = {
							nested: { path: node.p, query: { match_all: {} } },
						};
						if (value === true) {
							outFilters.push(nestedClause);
						} else {
							outMustNots.push(nestedClause);
						}
					}
				} else if (node.b !== undefined) {
					// Grouped leaf: one entry per (base name, OpenSearch path), with
					// node.k an ordered string of kind codes. Codes are expanded in
					// declaration order so the clause order matches the schema.
					const base = node.b;
					for (const code of node.k.split("")) {
						if (code === "t") {
							const v = input[base];
							if (v != null) {
								outFilters.push({ term: { [node.f]: v } });
							}
						} else if (code === "n") {
							const v = input[base + "Not"];
							if (v != null) {
								outMustNots.push({ term: { [node.f]: v } });
							}
						} else if (code === "s") {
							const v = input[base + "In"];
							if (v != null && v.length > 0) {
								outFilters.push({ terms: { [node.f]: v } });
							}
						} else if (code === "e") {
							const v = input[base + "Exists"];
							if (v != null) {
								if (v === true) {
									outFilters.push({ exists: { field: node.f } });
								} else {
									outMustNots.push({ exists: { field: node.f } });
								}
							}
						} else if (code === "p") {
							const v = input[base + "Prefix"];
							if (v != null && v !== "") {
								outFilters.push({ prefix: { [node.f]: v } });
							}
						} else if (code === "m") {
							const v = input[base + "Match"];
							if (v != null && v !== "") {
								outFilters.push({ match: { [node.f]: v } });
							}
						} else if (code === "r") {
							const bounds = {};
							let any = false;
							if (input[base + "Gte"] != null) {
								bounds.gte = input[base + "Gte"];
								any = true;
							}
							if (input[base + "Lte"] != null) {
								bounds.lte = input[base + "Lte"];
								any = true;
							}
							if (input[base + "Gt"] != null) {
								bounds.gt = input[base + "Gt"];
								any = true;
							}
							if (input[base + "Lt"] != null) {
								bounds.lt = input[base + "Lt"];
								any = true;
							}
							if (any) {
								outFilters.push({ range: { [node.f]: bounds } });
							}
						}
					}
				}
			}
		}
	}

	for (const _slot of finSlots) {
		if (finTail > 0) {
			finTail = finTail - 1;
			const item = finSlots[finTail];
			for (const clause of item.childFilters) {
				item.parentFilters.push({
					nested: {
						path: item.path,
						query: { bool: { filter: [clause] } },
					},
				});
			}
			for (const clause of item.childMustNots) {
				item.parentMustNots.push({
					nested: {
						path: item.path,
						query: { bool: { filter: [clause] } },
					},
				});
			}
		}
	}
}
