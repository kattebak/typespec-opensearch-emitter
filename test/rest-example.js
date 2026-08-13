import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// Issue #134 — Petstore worked example. `npm run test:emit:rest` compiles
// test/petstore/main.tsp into build/petstore-emit; these tests snapshot the
// SDL, the resolver files, and the manifest against test/snapshots/petstore.
const SNAPSHOT_DIR = "test/snapshots/petstore";
const EMIT_DIR = "build/petstore-emit";

test("petstore emit matches the committed snapshot byte-for-byte", async () => {
	const snapshotFiles = (await readdir(SNAPSHOT_DIR)).sort();
	const emittedFiles = (await readdir(EMIT_DIR)).sort();

	assert.deepEqual(emittedFiles, snapshotFiles);

	for (const fileName of snapshotFiles) {
		const expected = await readFile(`${SNAPSHOT_DIR}/${fileName}`);
		const actual = await readFile(`${EMIT_DIR}/${fileName}`);
		assert.ok(expected.equals(actual), `${fileName} diverges from snapshot`);
	}
});

test("SDL: GET → Query field, POST → Mutation field, body → input type", async () => {
	const sdl = await readFile(`${EMIT_DIR}/pet.graphql`, "utf8");

	assert.ok(sdl.includes("type Query {"));
	assert.ok(sdl.includes("  getPet(petId: String!): Pet"));
	assert.ok(sdl.includes("  listPets(status: String): [Pet!]"));
	assert.ok(sdl.includes("type Mutation {"));
	assert.ok(sdl.includes("  createPet(input: CreatePetInput!): Pet"));

	assert.ok(sdl.includes("type Pet {"));
	assert.ok(sdl.includes("input CreatePetInput {"));
	assert.ok(
		sdl.match(/enum PetStatus \{\n {2}Available\n {2}Pending\n {2}Sold\n\}/),
	);
});

test("resolver: path param interpolated via util.urlEncode", async () => {
	const resolver = await readFile(`${EMIT_DIR}/Query.getPet.js`, "utf8");

	assert.ok(resolver.includes('method: "GET"'));
	assert.ok(
		resolver.includes(
			"resourcePath: `/pets/${util.urlEncode(ctx.args.petId)}`",
		),
	);
});

test("resolver: mutation sends JSON body", async () => {
	const resolver = await readFile(`${EMIT_DIR}/Mutation.createPet.js`, "utf8");

	assert.ok(resolver.includes('method: "POST"'));
	assert.ok(resolver.includes('resourcePath: "/pets"'));
	assert.ok(resolver.includes("body: JSON.stringify(ctx.args.input)"));
});

test("resolver: query params land in params.query", async () => {
	const resolver = await readFile(`${EMIT_DIR}/Query.listPets.js`, "utf8");

	assert.ok(resolver.includes('"status": ctx.args.status'));
});

test("resolver: an exploded array param repeats its key in the resourcePath", async () => {
	const resolver = await readFile(`${EMIT_DIR}/Query.searchPets.js`, "utf8");

	assert.ok(!resolver.includes("query: {"));
	assert.ok(
		resolver.includes("resourcePath: `/pets/search${queryString(ctx)}`"),
	);

	const request = new Function(
		"util",
		"ctx",
		`${resolver
			.replace('import { util } from "@aws-appsync/utils";', "")
			.replaceAll("export function", "function")}\nreturn request(ctx);`,
	);
	const { resourcePath } = request(
		{ urlEncode: (value) => encodeURIComponent(value) },
		{
			args: { status: ["Available", "Sold"], name: "Rex" },
			identity: { resolverContext: { userId: "u1" } },
		},
	);

	assert.equal(
		resourcePath,
		"/pets/search?status=Available&status=Sold&name=Rex",
	);
});

test("resolver: injectHeaders config expands into BASE_HEADERS", async () => {
	const resolver = await readFile(`${EMIT_DIR}/Query.getPet.js`, "utf8");

	assert.ok(resolver.includes('"Content-Type": "application/json"'));
	assert.ok(
		resolver.includes('"x-user-id": ctx.identity.resolverContext.userId'),
	);
});

test("manifest: REST entries carry typeName/httpMethod/resourcePath/dataSource, no indexName", async () => {
	const manifest = JSON.parse(
		await readFile(`${EMIT_DIR}/graphql-resolvers.json`, "utf8"),
	);

	assert.equal(manifest.resolvers.length, 4);

	const getPet = manifest.resolvers.find((r) => r.fieldName === "getPet");
	assert.deepEqual(getPet, {
		typeName: "Query",
		fieldName: "getPet",
		dataSource: "HTTP",
		httpMethod: "GET",
		resourcePath: "/pets/{petId}",
		mode: "monolithic",
		resolverFile: "Query.getPet.js",
		sdlFile: "pet.graphql",
	});

	const createPet = manifest.resolvers.find((r) => r.fieldName === "createPet");
	assert.equal(createPet.typeName, "Mutation");
	assert.equal(createPet.httpMethod, "POST");
	assert.equal(createPet.resolverFile, "Mutation.createPet.js");

	for (const resolver of manifest.resolvers) {
		assert.ok(!("indexName" in resolver));
	}
});

test("generated resolvers contain no async or disallowed globals (APPSYNC_JS)", async () => {
	for (const fileName of [
		"Query.getPet.js",
		"Query.listPets.js",
		"Mutation.createPet.js",
		"Query.searchPets.js",
	]) {
		const resolver = await readFile(`${EMIT_DIR}/${fileName}`, "utf8");
		assert.ok(!resolver.includes("async "), `${fileName} uses async`);
		assert.ok(!resolver.includes("await "), `${fileName} uses await`);
		assert.ok(!resolver.includes("setTimeout"), `${fileName} uses setTimeout`);
		assert.ok(!resolver.includes("process."), `${fileName} uses process`);
		assert.ok(
			resolver.includes('import { util } from "@aws-appsync/utils"'),
			`${fileName} missing @aws-appsync/utils import`,
		);
	}
});

test("rest-only package.json carries artifacts only — no entrypoint, no tsc (issue #143)", async () => {
	const packageJson = JSON.parse(
		await readFile(`${EMIT_DIR}/package.json`, "utf8"),
	);

	assert.equal(packageJson.name, "@kattebak/petstore-rest");
	assert.ok(!("main" in packageJson));
	assert.ok(!("types" in packageJson));
	assert.ok(!("scripts" in packageJson));
	assert.ok(!("devDependencies" in packageJson));
	assert.ok(!("." in packageJson.exports));

	const emittedFiles = await readdir(EMIT_DIR);
	assert.ok(!emittedFiles.includes("tsconfig.json"));
	assert.ok(!emittedFiles.includes("index.ts"));
});
