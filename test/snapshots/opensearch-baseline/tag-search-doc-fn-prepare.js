import { util } from "@aws-appsync/utils";

const FILTER_SPEC = [{i:"name",k:"term",f:"name"}, {i:"nameNot",k:"term_negate",f:"name"}, {i:"noteExists",k:"exists",f:"note.keyword"}];

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
	const wantsAggs = ctx.info.selectionSetList.some((p) => p === "aggregations" || p.indexOf("aggregations/") === 0);
	if (wantsAggs) {
		body.aggs = {
		byName: { terms: { field: "name" } },
		uniqueNameCount: { cardinality: { field: "name" } },
		missingNoteCount: { missing: { field: "note.keyword" } },
	};
	}

	ctx.stash.queryBody = body;
	return { payload: null };
}

export function response(ctx) {
	return ctx.result;
}

function buildQuery(queryText, filter, searchFilter) {
	const musts = [];
	const filters = [];
	const mustNots = [];

	if (queryText) {
		musts.push({
			multi_match: {
				query: queryText,
				fields: ["note"],
				type: "best_fields",
			},
		});
	}

	const keywordFields = ["name"];
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
	// Always tie-break on _id for stable cursor pagination.
	out.push({ _id: "asc" });
	return out;
}

function applyFilterSpec(rootSpec, rootInput, rootOutFilters, rootOutMustNots) {
	if (!rootSpec || !rootInput) return;

	// APPSYNC_JS forbids while, continue, C-style for(init;cond;update), and
	// the increment/decrement unary operators (lint rules @aws-appsync/no-while,
	// @aws-appsync/no-continue, @aws-appsync/no-for,
	// @aws-appsync/no-disallowed-unary-operators), and recursion
	// (@aws-appsync/no-recursion). It also does not honor the ECMA spec for
	// Array's @@iterator: items pushed during `for...of` iteration are NOT
	// visited (verified via aws appsync evaluate-code). Iteration is driven
	// by fixed-length slot pools whose `for...of` runs exactly slots.length
	// times; bodies check head/tail indexes to act on real work.
	//
	// Two pools, two phases (issue #110):
	//   procSlots — FIFO process queue. Each process item walks a spec list,
	//     enqueueing more process items for nested/object descents.
	//   finSlots — finalize stack drained LIFO after all processing is done.
	//     Each "nested" descent pushes one finalize item carrying the
	//     child-clause arrays and the path to wrap them with. LIFO ordering
	//     guarantees deepest-first wrapping, so an inner nested's clauses
	//     are wrapped onto its outer parent's child-clause array BEFORE
	//     that outer parent's finalize runs.
	//
	// The previous single-FIFO design ran a parent's finalize before
	// descendant processing finished whenever a non-nested struct ("object"
	// kind) sat between two leaves and a nested ancestor — the descendant
	// term clause landed in childFilters AFTER finalize had already drained
	// it, silently dropping the filter (issue #110). The same hazard
	// applies to nested-of-nested: outer finalize ran before inner finalize
	// populated its parent's child-clause array. Splitting process and
	// finalize into separate pools fixes both.
	const procSlots = [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null];
	const finSlots = [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null];
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

			// FILTER_SPEC nodes use compact keys to fit under AppSync's 32 KB
			// per-function code cap (issue #99): i=inputName, k=kind, f=field,
			// p=path, c=children. See stringifyNode in the emitter. Range
			// kind carries one entry per field; the function expands the
			// four bound inputs (i+"Gte"/Lte/Gt/Lt) at iteration time
			// (issue #101).
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
				} else if (node.k === "term") {
					if (value != null) {
						outFilters.push({ term: { [node.f]: value } });
					}
				} else if (node.k === "term_negate") {
					if (value != null) {
						outMustNots.push({ term: { [node.f]: value } });
					}
				} else if (node.k === "terms") {
					if (value != null && value.length > 0) {
						outFilters.push({ terms: { [node.f]: value } });
					}
				} else if (node.k === "exists") {
					if (value != null) {
						if (value === true) {
							outFilters.push({ exists: { field: node.f } });
						} else {
							outMustNots.push({ exists: { field: node.f } });
						}
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
				} else if (node.k === "range") {
					const base = node.i;
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
				} else if (node.k === "prefix") {
					if (value != null && value !== "") {
						outFilters.push({ prefix: { [node.f]: value } });
					}
				} else if (node.k === "match") {
					if (value != null && value !== "") {
						outFilters.push({ match: { [node.f]: value } });
					}
				}
			}
		}
	}

	// Finalize phase: drain LIFO. Deepest finalize first wraps its child
	// clauses onto its parent's childFilters/childMustNots array; that
	// parent's finalize, popped later, then sees those wrapped clauses and
	// wraps them in its own nested+path on the way to the grandparent.
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
