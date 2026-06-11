import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// Issue #136 — Petstore example with the opt-in @graphqlId marker.
// `npm run test:emit:rest:id` compiles test/petstore-id/main.tsp into
// build/petstore-id-emit; these tests snapshot the output and pin the two
// invariants: opt-in fields surface as ID, resolver codegen is unaffected.
const SNAPSHOT_DIR = "test/snapshots/petstore-id";
const EMIT_DIR = "build/petstore-id-emit";
const PLAIN_EMIT_DIR = "build/petstore-emit";

test("petstore-id emit matches the committed snapshot byte-for-byte", async () => {
	const snapshotFiles = (await readdir(SNAPSHOT_DIR)).sort();
	const emittedFiles = (await readdir(EMIT_DIR)).sort();

	assert.deepEqual(emittedFiles, snapshotFiles);

	for (const fileName of snapshotFiles) {
		const expected = await readFile(`${SNAPSHOT_DIR}/${fileName}`);
		const actual = await readFile(`${EMIT_DIR}/${fileName}`);
		assert.ok(expected.equals(actual), `${fileName} diverges from snapshot`);
	}
});

test("SDL: @graphqlId surfaces as ID on the arg and the object field", async () => {
	const sdl = await readFile(`${EMIT_DIR}/pet.graphql`, "utf8");

	assert.ok(sdl.includes("  getPet(petId: ID!): Pet"));
	assert.ok(sdl.includes("type Pet {\n  petId: ID!"));
	// undecorated strings stay String — no heuristics
	assert.ok(sdl.includes("  listPets(status: String): [Pet!]"));
	assert.ok(sdl.includes("  name: String!"));
});

test("resolvers: codegen unaffected by @graphqlId — byte-identical to plain petstore", async () => {
	for (const fileName of [
		"Query.getPet.js",
		"Query.listPets.js",
		"Mutation.createPet.js",
		"graphql-resolvers.js",
	]) {
		const plain = await readFile(`${PLAIN_EMIT_DIR}/${fileName}`);
		const optIn = await readFile(`${EMIT_DIR}/${fileName}`);
		assert.ok(plain.equals(optIn), `${fileName} diverges from plain petstore`);
	}
});

test("resolver: util.urlEncode interpolation unchanged", async () => {
	const resolver = await readFile(`${EMIT_DIR}/Query.getPet.js`, "utf8");

	assert.ok(
		resolver.includes(
			"resourcePath: `/pets/${util.urlEncode(ctx.args.petId)}`",
		),
	);
});
