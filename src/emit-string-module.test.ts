import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	__test,
	collectStringModules,
	emitResolverBarrel,
	emitResolverStringModule,
	emitSdlBarrel,
	emitSdlStringModule,
	resolverModuleSpecifier,
	sdlModuleSpecifier,
} from "./emit-string-module.js";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NUL = String.fromCharCode(0);

function readStringExport(moduleSource: string, exportName: string): string {
	const prefix = `export const ${exportName} = `;
	assert.ok(moduleSource.startsWith(prefix), moduleSource.slice(0, 40));
	assert.ok(moduleSource.endsWith(";\n"));
	const literal = moduleSource.slice(prefix.length, -";\n".length);
	return JSON.parse(literal) as string;
}

describe("emitResolverStringModule", () => {
	it("names the module after the resolver file, without the extension", () => {
		const module = emitResolverStringModule(
			"pet-search-doc-resolver.js",
			"export const x = 1;\n",
		);

		assert.equal(module.fileName, "resolvers/pet-search-doc-resolver.ts");
		assert.equal(module.moduleSpecifier, "resolvers/pet-search-doc-resolver");
		assert.equal(
			resolverModuleSpecifier("pet-search-doc-resolver.js"),
			module.moduleSpecifier,
		);
	});

	it("names a pipeline function file the same way, split suffix included", () => {
		assert.equal(
			resolverModuleSpecifier("pet-search-doc-fn-prepare-query-1.js"),
			"resolvers/pet-search-doc-fn-prepare-query-1",
		);
		assert.equal(
			resolverModuleSpecifier("pet-search-doc-fn-normalize-2.js"),
			"resolvers/pet-search-doc-fn-normalize-2",
		);
	});

	it("kebab-cases a dotted REST resolver file name", () => {
		assert.equal(
			resolverModuleSpecifier("Query.getPet.js"),
			"resolvers/query-get-pet",
		);
	});

	it("round-trips a body carrying every escape hazard byte-identically", () => {
		const source = [
			'const backslash = "\\";',
			"const quotes = 'single' + \"double\" + `back`;",
			"const template = `${ctx.args.query}`;",
			"const dollarBrace = '${';",
			"const closeScript = '</script>';",
			`const lineSeparator = "${LINE_SEPARATOR}";`,
			`const paragraphSeparator = "${PARAGRAPH_SEPARATOR}";`,
			`const nul = "${NUL}";`,
			'const tabCr = "\t\r\n";',
			"",
		].join("\n");

		const module = emitResolverStringModule("x-resolver.js", source);

		assert.ok(!module.content.includes(LINE_SEPARATOR));
		assert.ok(!module.content.includes(PARAGRAPH_SEPARATOR));
		assert.ok(module.content.includes("\\u2028"));
		assert.ok(module.content.includes("\\u2029"));
		assert.equal(module.content.split("\n").length, 2);
		assert.equal(readStringExport(module.content, "code"), source);
	});

	it("round-trips an SDL fragment carrying the same hazards", () => {
		const sdl = [
			'type Doc { note: String @deprecated(reason: "use \\"note2\\"") }',
			'"""block ${description}"""',
			`# ${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`,
			"",
		].join("\n");

		const module = emitSdlStringModule("doc.graphql", sdl);

		assert.equal(module.fileName, "schema/doc.ts");
		assert.equal(module.moduleSpecifier, "schema/doc");
		assert.equal(sdlModuleSpecifier("doc.graphql"), module.moduleSpecifier);
		assert.equal(readStringExport(module.content, "sdl"), sdl);
	});
});

describe("emitResolverBarrel", () => {
	it("keys both records by the module specifier the manifest carries", () => {
		const resolvers = [
			emitResolverStringModule("pet-search-doc-resolver.js", "resolver"),
		];
		const functions = [
			emitResolverStringModule("pet-search-doc-fn-prepare.js", "prepare"),
			emitResolverStringModule("pet-search-doc-fn-normalize-1.js", "normalize"),
		];

		const barrel = emitResolverBarrel(resolvers, functions);

		assert.equal(barrel.fileName, "resolvers/index.ts");
		assert.equal(barrel.moduleSpecifier, "resolvers");
		assert.ok(
			barrel.content.includes('"resolvers/pet-search-doc-resolver":'),
			barrel.content,
		);
		assert.ok(
			barrel.content.includes('"resolvers/pet-search-doc-fn-prepare":'),
		);
		assert.ok(
			barrel.content.includes('"resolvers/pet-search-doc-fn-normalize-1":'),
		);
		assert.ok(
			barrel.content.includes(
				"export const resolverCode: Record<string, string>",
			),
		);
		assert.ok(
			barrel.content.includes(
				"export const pipelineFunctionCode: Record<string, string>",
			),
		);
	});

	it("imports every module it keys, relative and extensioned for NodeNext", () => {
		const barrel = emitResolverBarrel(
			[emitResolverStringModule("a-resolver.js", "a")],
			[emitResolverStringModule("a-fn-prepare.js", "b")],
		);

		assert.ok(barrel.content.includes('from "./a-resolver.js";'));
		assert.ok(barrel.content.includes('from "./a-fn-prepare.js";'));
	});

	it("emits empty records rather than dangling imports when nothing was emitted", () => {
		const barrel = emitResolverBarrel([], []);

		assert.ok(
			barrel.content.startsWith(
				"export const resolverCode: Record<string, string> = {};",
			),
		);
		assert.ok(
			barrel.content.includes(
				"export const pipelineFunctionCode: Record<string, string> = {};",
			),
		);
	});

	it("does not collide a binding with a record name or another binding", () => {
		const barrel = emitResolverBarrel(
			[emitResolverStringModule("resolver-code.js", "a")],
			[emitResolverStringModule("resolver.code.js", "b")],
		);

		assert.ok(!barrel.content.includes("as resolverCode }"));
		const bindings = [...barrel.content.matchAll(/ as (\w+) \}/g)].map(
			(match) => match[1],
		);
		assert.equal(new Set(bindings).size, bindings.length);
	});
});

describe("emitSdlBarrel", () => {
	it("keys the record by the schema module specifier", () => {
		const barrel = emitSdlBarrel([
			emitSdlStringModule("pet-search-doc.graphql", "type Pet"),
			emitSdlStringModule("tag-search-doc.graphql", "type Tag"),
		]);

		assert.equal(barrel.fileName, "schema/index.ts");
		assert.equal(barrel.moduleSpecifier, "schema");
		assert.ok(barrel.content.includes('"schema/pet-search-doc":'));
		assert.ok(barrel.content.includes('"schema/tag-search-doc":'));
		assert.ok(
			barrel.content.includes("export const sdl: Record<string, string>"),
		);
	});
});

describe("collectStringModules", () => {
	it("returns every module plus the two barrels", () => {
		const modules = collectStringModules(
			[emitResolverStringModule("a-resolver.js", "a")],
			[emitResolverStringModule("a-fn-prepare.js", "b")],
			[emitSdlStringModule("a.graphql", "type A")],
		);

		assert.deepEqual(
			modules.map((module) => module.fileName),
			[
				"resolvers/a-resolver.ts",
				"resolvers/a-fn-prepare.ts",
				"schema/a.ts",
				"resolvers/index.ts",
				"schema/index.ts",
			],
		);
	});

	it("collapses an SDL fragment emitted for more than one projection", () => {
		const modules = collectStringModules(
			[],
			[],
			[
				emitSdlStringModule("pet.graphql", "type Pet"),
				emitSdlStringModule("pet.graphql", "type Pet"),
			],
		);

		assert.deepEqual(
			modules.map((module) => module.fileName),
			["schema/pet.ts", "resolvers/index.ts", "schema/index.ts"],
		);
	});

	it("emits nothing when no resolver or SDL was written", () => {
		assert.deepEqual(collectStringModules([], [], []), []);
	});
});

describe("moduleBaseName", () => {
	it("keeps an already-kebab name unchanged", () => {
		assert.equal(
			__test.moduleBaseName("pet-search-doc-resolver.js"),
			"pet-search-doc-resolver",
		);
	});

	it("strips only the final extension", () => {
		assert.equal(__test.moduleBaseName("a.b.graphql"), "a-b");
	});
});
