import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emitIndex, toIndexConstantName } from "./emit-index.js";
import type { ResolvedProjection } from "./projection.js";

describe("index emitter", () => {
	it("emits index.ts with type exports and index constants", () => {
		const projections = [
			{
				projectionModel: { name: "ProductSearchDoc" },
				sourceModel: { name: "Product" },
				indexName: "products_v1",
				fields: [],
			},
			{
				projectionModel: { name: "AccountSearchDoc" },
				sourceModel: { name: "Account" },
				indexName: "accounts_v1",
				fields: [],
			},
		] as unknown as ResolvedProjection[];

		const emitted = emitIndex(projections);
		assert.equal(emitted.fileName, "index.ts");
		assert.equal(
			emitted.content.includes(
				'export type { AccountSearchDoc } from "./account-search-doc.js";',
			),
			true,
		);
		assert.equal(
			emitted.content.includes(
				'export const ACCOUNT_SEARCH_DOC_INDEX_NAME = "accounts_v1";',
			),
			true,
		);
		assert.equal(
			emitted.content.includes(
				'export type { ProductSearchDoc } from "./product-search-doc.js";',
			),
			true,
		);
		assert.equal(
			emitted.content.includes(
				'export const PRODUCT_SEARCH_DOC_INDEX_NAME = "products_v1";',
			),
			true,
		);
	});

	it("derives constant names from projection model names", () => {
		assert.equal(
			toIndexConstantName("CounterpartySearchDoc"),
			"COUNTERPARTY_SEARCH_DOC_INDEX_NAME",
		);
		assert.equal(
			toIndexConstantName("PetStoreSearchDoc"),
			"PET_STORE_SEARCH_DOC_INDEX_NAME",
		);
	});

	it("avoids collisions for multiple projections of same source model", () => {
		const projections = [
			{
				projectionModel: { name: "AccountSearchDoc" },
				sourceModel: { name: "Account" },
				indexName: "accounts_v1",
				fields: [],
			},
			{
				projectionModel: { name: "AccountSummarySearchDoc" },
				sourceModel: { name: "Account" },
				indexName: "accounts_summary_v1",
				fields: [],
			},
		] as unknown as ResolvedProjection[];

		const emitted = emitIndex(projections);
		assert.equal(
			emitted.content.includes(
				'export const ACCOUNT_SEARCH_DOC_INDEX_NAME = "accounts_v1";',
			),
			true,
		);
		assert.equal(
			emitted.content.includes(
				'export const ACCOUNT_SUMMARY_SEARCH_DOC_INDEX_NAME = "accounts_summary_v1";',
			),
			true,
		);
	});
});
