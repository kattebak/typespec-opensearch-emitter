import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Issue #201 — `npm run test:emit:terms` compiles test/terms-size/main.tsp with
// `graphql.terms-buckets: 25` into build/terms-size-emit.
const EMIT_DIR = "build/terms-size-emit";

async function resolver() {
	return readFile(`${EMIT_DIR}/trade-search-doc-resolver.js`, "utf8");
}

test("a terms aggregation without a size takes the terms-buckets option", async () => {
	assert.ok(
		(await resolver()).includes(
			'{n:"byDesk",a:{ terms: { field: "desk", size: 25 } }}',
		),
	);
});

test("a per-field size overrides the option on a plain terms aggregation", async () => {
	assert.ok(
		(await resolver()).includes(
			'{n:"byCounterpartyId",a:{ terms: { field: "counterpartyId", size: 500 } }}',
		),
	);
});

test("a per-field size overrides the option on a terms aggregation with sub-aggs", async () => {
	const content = await resolver();
	assert.ok(
		content.includes(
			'{n:"byBook",a:{ terms: { field: "book", size: 40 }, aggs: { "largestNotional": { max: { field: "notional" } } } }}',
		),
	);
	assert.ok(
		content.includes(
			'{n:"byTrader",a:{ terms: { field: "trader", size: 5 }, aggs: { "hits": { top_hits: { size: 2 } } } }}',
		),
	);
});

test("raised terms sizes come off the histogram bucket budget", async () => {
	const content = await resolver();
	assert.ok(content.includes("let reserved = 0;"));
	assert.ok(
		content.includes(
			"if (spec.a.terms && spec.a.terms.size > 10) reserved += spec.a.terms.size;",
		),
	);
	assert.ok(
		content.includes("Math.floor((21845 - reserved) / histograms.length)"),
	);
});

test("the SDL keeps the shared TermBucket type for a sized terms aggregation", async () => {
	const sdl = await readFile(`${EMIT_DIR}/trade-search-doc.graphql`, "utf8");
	assert.ok(sdl.includes("byDesk: [TermBucket!]!"));
	assert.ok(sdl.includes("byCounterpartyId: [TermBucket!]!"));
});
