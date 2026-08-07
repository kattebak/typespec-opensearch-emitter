import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Issue #1068 — resolver and SDL source also ship as `.ts` modules exporting
// the text as a string, so a consumer imports the code instead of resolving a
// path and reading the file. Asserted against the emitted output rather than
// the code that builds it, so it holds for every resolver shape — including
// the request-side and response-walker splits, whose file names the projection
// name does not predict.
const EMIT_DIRS = ["build/package-emit", "build/package-split-emit"];
const SOURCE_ONLY_EMIT_DIR = "build/opensearch-emit";

async function readEmit(emitDir) {
	const manifest = JSON.parse(
		await readFile(`${emitDir}/graphql-resolvers.json`, "utf8"),
	);
	return {
		searchEntries: manifest.resolvers.filter((entry) => "projection" in entry),
		nestedTypes: manifest.nestedTypes ?? [],
	};
}

function readStringExport(moduleSource, exportName) {
	const prefix = `export const ${exportName} = `;
	assert.ok(
		moduleSource.startsWith(prefix),
		`module does not export ${exportName}`,
	);
	return JSON.parse(moduleSource.slice(prefix.length, -";\n".length));
}

async function assertStringModulesMatchFiles(emitDir) {
	const { searchEntries, nestedTypes } = await readEmit(emitDir);
	assert.ok(searchEntries.length > 0, "no search entries to check");

	const codePairs = searchEntries.flatMap((entry) => [
		{ file: entry.resolverFile, module: entry.resolverModule },
		...entry.functions.map((fn) => ({ file: fn.file, module: fn.module })),
	]);
	for (const { file, module } of codePairs) {
		assert.equal(module, `resolvers/${file.replace(/\.js$/, "")}`);
		const moduleSource = await readFile(`${emitDir}/${module}.ts`, "utf8");
		assert.equal(
			readStringExport(moduleSource, "code"),
			await readFile(`${emitDir}/${file}`, "utf8"),
			`${module} diverges from ${file}`,
		);
	}

	const sdlPairs = [...searchEntries, ...nestedTypes].map((entry) => ({
		file: entry.sdlFile,
		module: entry.sdlModule,
	}));
	for (const { file, module } of sdlPairs) {
		assert.equal(module, `schema/${file.replace(/\.graphql$/, "")}`);
		const moduleSource = await readFile(`${emitDir}/${module}.ts`, "utf8");
		assert.equal(
			readStringExport(moduleSource, "sdl"),
			await readFile(`${emitDir}/${file}`, "utf8"),
			`${module} diverges from ${file}`,
		);
	}
}

test(`${SOURCE_ONLY_EMIT_DIR}: string modules carry the emitted source verbatim`, async () => {
	await assertStringModulesMatchFiles(SOURCE_ONLY_EMIT_DIR);
});

for (const emitDir of EMIT_DIRS) {
	test(`${emitDir}: string modules carry the emitted source verbatim`, async () => {
		await assertStringModulesMatchFiles(emitDir);
	});

	test(`${emitDir}: exports declares every string module as an extensionless specifier`, async () => {
		const { searchEntries, nestedTypes } = await readEmit(emitDir);
		const packageJson = JSON.parse(
			await readFile(`${emitDir}/package.json`, "utf8"),
		);

		const specifiers = [
			...searchEntries.flatMap((entry) => [
				entry.resolverModule,
				entry.sdlModule,
				...entry.functions.map((fn) => fn.module),
			]),
			...nestedTypes.map((entry) => entry.sdlModule),
		];

		for (const specifier of new Set(specifiers)) {
			assert.deepEqual(
				packageJson.exports[`./${specifier}`],
				{
					types: `./${specifier}.d.ts`,
					default: `./${specifier}.js`,
				},
				`exports is missing ./${specifier}`,
			);
		}

		for (const barrel of ["resolvers", "schema"]) {
			assert.deepEqual(
				packageJson.exports[`./${barrel}`],
				{
					types: `./${barrel}/index.d.ts`,
					default: `./${barrel}/index.js`,
				},
				`exports is missing the ./${barrel} barrel`,
			);
		}
	});

	test(`${emitDir}: the shipped tsconfig compiles every string module`, async () => {
		const tsConfig = JSON.parse(
			await readFile(`${emitDir}/tsconfig.json`, "utf8"),
		);
		const moduleSources = (await readdir(emitDir, { recursive: true })).filter(
			(fileName) =>
				fileName.endsWith(".ts") &&
				!fileName.endsWith(".d.ts") &&
				(fileName.startsWith("resolvers/") || fileName.startsWith("schema/")),
		);

		assert.ok(moduleSources.length > 0, "no string modules were emitted");
		for (const fileName of moduleSources) {
			assert.ok(
				tsConfig.include.includes(fileName),
				`tsconfig does not include ${fileName}`,
			);
		}
	});

	// The barrel is what makes the manifest loadable with one static import per
	// package: the consumer iterates `resolvers[]` and looks each entry's code
	// up by the specifier the manifest carries. A key the barrel omits reads
	// back as `undefined`, which AppSync accepts at synth and rejects at
	// deploy, so the key sets must agree exactly.
	test(`${emitDir}: the barrels key exactly the specifiers the manifest names`, async () => {
		const distDir = `${emitDir}-barrel-dist`;
		await execFileAsync("npx", [
			"tsc",
			"-p",
			`${emitDir}/tsconfig.json`,
			"--outDir",
			distDir,
		]);
		const { searchEntries, nestedTypes } = await readEmit(emitDir);
		const resolvers = await import(
			pathToFileURL(`${distDir}/resolvers/index.js`).href
		);
		const schema = await import(
			pathToFileURL(`${distDir}/schema/index.js`).href
		);

		assert.deepEqual(
			Object.keys(resolvers.resolverCode).sort(),
			searchEntries.map((entry) => entry.resolverModule).sort(),
		);
		assert.deepEqual(
			Object.keys(resolvers.pipelineFunctionCode).sort(),
			searchEntries
				.flatMap((entry) => entry.functions.map((fn) => fn.module))
				.sort(),
		);
		assert.deepEqual(
			Object.keys(schema.sdl).sort(),
			[
				...new Set(
					[...searchEntries, ...nestedTypes].map((entry) => entry.sdlModule),
				),
			].sort(),
		);

		for (const entry of searchEntries) {
			assert.equal(
				resolvers.resolverCode[entry.resolverModule],
				await readFile(`${emitDir}/${entry.resolverFile}`, "utf8"),
			);
			assert.equal(
				schema.sdl[entry.sdlModule],
				await readFile(`${emitDir}/${entry.sdlFile}`, "utf8"),
			);
			for (const fn of entry.functions) {
				assert.equal(
					resolvers.pipelineFunctionCode[fn.module],
					await readFile(`${emitDir}/${fn.file}`, "utf8"),
				);
			}
		}
	});
}
