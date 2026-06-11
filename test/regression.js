import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// Issue #134 hard constraint: a .tsp with no @restResolver must emit
// byte-identical output to pre-REST main. test/snapshots/opensearch-baseline
// was captured from the unmodified main emit of test/main.tsp; this compares
// the fresh emit (produced by `npm run test:emit`) file-by-file, byte-by-byte.
const SNAPSHOT_DIR = "test/snapshots/opensearch-baseline";
const EMIT_DIR = "build/opensearch-emit";

// test/example.js writes these into EMIT_DIR for its "generated output
// compiles" check — they are test-harness artifacts, not emitter output.
const TEST_HARNESS_ARTIFACTS = new Set(["tsconfig.json", "dist"]);

test("OpenSearch-only emit is byte-identical to the pre-REST baseline", async () => {
	const snapshotFiles = (await readdir(SNAPSHOT_DIR)).sort();
	const emittedFiles = (await readdir(EMIT_DIR))
		.filter((fileName) => !TEST_HARNESS_ARTIFACTS.has(fileName))
		.sort();

	assert.deepEqual(
		emittedFiles,
		snapshotFiles,
		"emitted file list diverges from baseline",
	);

	for (const fileName of snapshotFiles) {
		const expected = await readFile(`${SNAPSHOT_DIR}/${fileName}`);
		const actual = await readFile(`${EMIT_DIR}/${fileName}`);
		assert.ok(
			expected.equals(actual),
			`${fileName} diverges from the pre-REST baseline`,
		);
	}
});
