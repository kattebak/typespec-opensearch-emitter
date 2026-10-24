import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Issue #206 — `npm run test:emit:rest:union` compiles
// test/field-union/main.tsp into build/field-union-emit.
const SNAPSHOT_DIR = "test/snapshots/field-union";
const EMIT_DIR = "build/field-union-emit";

function loadResponse(source) {
	return new Function(
		"util",
		`${source
			.replace('import { util } from "@aws-appsync/utils";', "")
			.replaceAll("export function", "function")}\nreturn response;`,
	)({ error: (message) => assert.fail(message) });
}

function okResult(body) {
	return { result: { statusCode: 200, body: JSON.stringify(body) } };
}

test("field-union emit matches the committed snapshot byte-for-byte", async () => {
	const snapshotFiles = (await readdir(SNAPSHOT_DIR)).sort();
	const emittedFiles = (await readdir(EMIT_DIR)).sort();

	assert.deepEqual(emittedFiles, snapshotFiles);

	for (const fileName of snapshotFiles) {
		const expected = await readFile(`${SNAPSHOT_DIR}/${fileName}`);
		const actual = await readFile(`${EMIT_DIR}/${fileName}`);
		assert.ok(expected.equals(actual), `${fileName} diverges from snapshot`);
	}
});

test("SDL: a union of models emits as a GraphQL union per template instance", async () => {
	const sdl = await readFile(`${EMIT_DIR}/quote.graphql`, "utf8");

	assert.ok(
		sdl.includes(
			"union DecimalAmountField = DecimalAmountFieldValue | FieldNoData | FieldNotInSubscription",
		),
	);
	assert.ok(
		sdl.includes(
			"union Int32Field = Int32FieldValue | FieldNoData | FieldNotInSubscription",
		),
	);
	assert.ok(
		sdl.includes(
			"type DecimalAmountFieldValue {\n  kind: String!\n  value: Float!\n}",
		),
	);
	assert.ok(
		sdl.includes("type Int32FieldValue {\n  kind: String!\n  value: Int!\n}"),
	);
	assert.ok(sdl.includes("  price: DecimalAmountField!"));
	assert.ok(sdl.includes("  history: [DecimalAmountField!]!"));
});

test("SDL: a union with a scalar variant keeps the scalar mapping", async () => {
	const sdl = await readFile(`${EMIT_DIR}/quote.graphql`, "utf8");

	assert.ok(sdl.includes("  settlement: String!"));
	assert.ok(!sdl.includes("union Settlement"));
});

test("resolver: every union value gets __typename from its discriminator", async () => {
	const response = loadResponse(
		await readFile(`${EMIT_DIR}/Query.listQuotes.js`, "utf8"),
	);

	const [quote] = response(
		okResult([
			{
				quoteId: "q1",
				price: { kind: "Value", value: 1.5 },
				quantity: { kind: "NotInSubscription" },
				history: [{ kind: "NoData" }, { kind: "Value", value: 2 }],
				settlement: "pending",
			},
		]),
	);

	assert.equal(quote.price.__typename, "DecimalAmountFieldValue");
	assert.equal(quote.quantity.__typename, "FieldNotInSubscription");
	assert.deepEqual(
		quote.history.map((field) => field.__typename),
		["FieldNoData", "DecimalAmountFieldValue"],
	);
	assert.equal(quote.settlement, "pending");
});

test("resolver: an absent union value is left alone", async () => {
	const response = loadResponse(
		await readFile(`${EMIT_DIR}/Query.getQuote.js`, "utf8"),
	);

	assert.deepEqual(response(okResult({ quoteId: "q1", price: null })), {
		quoteId: "q1",
		price: null,
	});
});

test("resolver: the emitted resolvers pass the APPSYNC_JS lint", async () => {
	const { ESLint } = await import("eslint");
	const { default: appsyncPlugin } = await import("@aws-appsync/eslint-plugin");
	const fileNames = ["Query.getQuote.js", "Query.listQuotes.js"];
	const dir = await mkdtemp(join(tmpdir(), "field-union-lint-"));
	try {
		for (const fileName of fileNames) {
			await writeFile(
				join(dir, fileName),
				await readFile(`${EMIT_DIR}/${fileName}`, "utf8"),
			);
		}
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { allowJs: true, noEmit: true, module: "ES2022" },
				include: fileNames,
			}),
		);
		const eslint = new ESLint({
			cwd: dir,
			overrideConfigFile: true,
			overrideConfig: [
				{
					...appsyncPlugin.configs.recommended,
					languageOptions: {
						...appsyncPlugin.configs.recommended.languageOptions,
						sourceType: "module",
						ecmaVersion: 2022,
						parserOptions: {
							project: "./tsconfig.json",
							tsconfigRootDir: dir,
							ecmaVersion: 2022,
							sourceType: "module",
						},
					},
				},
			],
		});
		const results = await eslint.lintFiles(
			fileNames.map((name) => join(dir, name)),
		);
		const messages = results.flatMap((result) =>
			result.messages.map((message) => `${message.ruleId}: ${message.message}`),
		);
		assert.deepEqual(messages, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
