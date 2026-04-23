import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("emits OpenSearch projection file", async () => {
	const content = await readFile(
		"build/opensearch/opensearch-projections.json",
		"utf8",
	);
	const parsed = JSON.parse(content);

	assert.deepEqual(parsed.models, ["ProductDocument"]);
});
