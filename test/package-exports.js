import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// Issue #184: a generated package is only loadable if its `exports` map and
// its files agree. Asserted against the emitted output rather than the code
// that builds the map, so it holds for every resolver shape the emitter can
// choose — monolithic, pipeline, and the split pipeline whose function file
// names carry a suffix the projection name does not predict.
const EMIT_DIRS = [
	"build/package-emit",
	"build/package-split-emit",
	"build/petstore-emit",
];

// Issue #1068 — the string-module subpaths. A rest-only package emits none.
const STRING_MODULE_EMIT_DIRS = [
	"build/package-emit",
	"build/package-split-emit",
];

async function readPackage(emitDir) {
	const files = new Set(await readdir(emitDir));
	const packageJson = JSON.parse(
		await readFile(`${emitDir}/package.json`, "utf8"),
	);
	return { files, exports: packageJson.exports };
}

for (const emitDir of EMIT_DIRS) {
	test(`${emitDir}: every export subpath resolves to an emitted file`, async () => {
		const { files, exports } = await readPackage(emitDir);
		const subpaths = Object.keys(exports).filter(
			(key) => key !== "." && typeof exports[key] === "string",
		);

		assert.ok(subpaths.length > 0, "no artifact subpaths to check");
		for (const subpath of subpaths) {
			const fileName = subpath.slice("./".length);
			assert.ok(
				files.has(fileName),
				`exports declares ${subpath} but the package ships no ${fileName}`,
			);
			assert.equal(exports[subpath], subpath);
		}
	});

	test(`${emitDir}: every emitted pipeline function has an export subpath`, async () => {
		const { files, exports } = await readPackage(emitDir);
		const functionFiles = [...files].filter((fileName) =>
			/-fn-.*\.js$/.test(fileName),
		);

		for (const fileName of functionFiles) {
			assert.ok(
				Object.hasOwn(exports, `./${fileName}`),
				`${fileName} is emitted but has no export subpath`,
			);
		}
	});
}

// String-module subpaths (issue #1068) are extensionless and resolve to the
// compiled output, so the shipped file to check is the `.ts` source.
for (const emitDir of STRING_MODULE_EMIT_DIRS) {
	test(`${emitDir}: every string-module subpath resolves to an emitted .ts source`, async () => {
		const { exports } = await readPackage(emitDir);
		const subpaths = Object.keys(exports).filter(
			(key) => key !== "." && typeof exports[key] === "object",
		);

		assert.ok(subpaths.length > 0, "no string-module subpaths to check");
		for (const subpath of subpaths) {
			const target = exports[subpath].default;
			assert.equal(exports[subpath].types, target.replace(/\.js$/, ".d.ts"));
			await readFile(
				`${emitDir}/${target.slice("./".length).replace(/\.js$/, ".ts")}`,
				"utf8",
			);
		}
	});
}

test("the split emit exercises the shapes the projection name cannot predict", async () => {
	const { files } = await readPackage("build/package-split-emit");
	const functionFiles = [...files].filter((fileName) =>
		/-fn-.*\.js$/.test(fileName),
	);

	for (const suffix of [
		"-fn-prepare-query.js",
		"-fn-prepare-query-1.js",
		"-fn-prepare-aggs.js",
		"-fn-normalize.js",
	]) {
		assert.ok(
			functionFiles.some((fileName) => fileName.endsWith(suffix)),
			`no emitted function file ends in ${suffix}`,
		);
	}
});

test("the pipeline emit exercises the unsplit shape", async () => {
	const { files } = await readPackage("build/package-emit");
	const functionFiles = [...files].filter((fileName) =>
		/-fn-.*\.js$/.test(fileName),
	);

	assert.ok(
		functionFiles.some((fileName) => fileName.endsWith("-fn-prepare.js")),
		"no emitted function file ends in -fn-prepare.js",
	);
});
