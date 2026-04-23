import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { emitDocType } from "./emit-doc-type.js";
import { resolveProjectionModel } from "./projection.js";
import { OpenSearchEmitterTestLibrary } from "./testing/index.js";

async function createRunner() {
	const host = await createTestHost({
		libraries: [OpenSearchEmitterTestLibrary],
	});

	return createTestWrapper(host, {
		autoImports: ["@kattebak/typespec-opensearch-emitter"],
		autoUsings: ["Kattebak.OpenSearch"],
	});
}

describe("doc type emitter", () => {
	it("emits TypeScript interface for projection model", async () => {
		const runner = await createRunner();
		const diagnostics = await runner.diagnose(`
      model Owner {
        @searchable name: string;
        email: string;
      }

      model Product {
        @searchable id: string;
        @searchable price: float64;
        @searchable owner: Owner;
        @searchable tags: string[];
      }

      model ProductSearchDoc is SearchProjection<Product> {}
    `);
		assert.equal(diagnostics.length, 0);

		const projection = runner.program
			.getGlobalNamespaceType()
			.models.get("ProductSearchDoc");
		assert.ok(projection);

		const resolved = resolveProjectionModel(runner.program, projection);
		assert.ok(resolved);

		const emitted = emitDocType(runner.program, resolved);
		assert.equal(emitted.fileName, "product-search-doc.ts");
		assert.equal(
			emitted.content.includes("export interface ProductSearchDoc"),
			true,
		);
		assert.equal(emitted.content.includes("\tid: string;"), true);
		assert.equal(emitted.content.includes("\tprice: number;"), true);
		assert.equal(emitted.content.includes("\towner:"), true);
		assert.equal(emitted.content.includes("\ttags: string[];"), true);
		assert.equal(emitted.content.includes("email"), false);
	});
});
