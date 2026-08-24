import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

const execFileAsync = promisify(execFile);

// Issue #194 — the pet care view. Waffles the beagle has a passport, Nugget
// the stray does not, so his document carries no passport and no ownership
// history; rehoming Waffles writes an OwnershipRecord and re-indexes him.
// `npm run test:emit:joins` compiles test/pet-care/main.tsp into
// build/pet-care-emit.
const EMIT_DIR = "build/pet-care-emit";

const ajv = new Ajv2020({ strict: true });

async function compileSchema(fileName) {
	return ajv.compile(JSON.parse(await readFile(`schema/${fileName}`, "utf8")));
}

const validateDependencies = await compileSchema("dependencies.schema.json");
const validateResolvableBy = await compileSchema("resolvable-by.schema.json");

async function readJson(fileName) {
	return JSON.parse(await readFile(`${EMIT_DIR}/${fileName}`, "utf8"));
}

function assertValid(validate, value) {
	assert.ok(
		validate(value),
		`${JSON.stringify(value)} violates the schema: ${ajv.errorsText(validate.errors)}`,
	);
}

test("projection manifest carries dependencies[], one entry per declaration", async () => {
	const manifest = await readJson("opensearch-projections.json");
	const petCare = manifest.projections.find(
		(x) => x.name === "PetCareSearchDoc",
	);

	assert.ok(petCare);
	assert.deepEqual(petCare.dependencies, [
		{ entity: "PetPassport", direction: "lookup", joinKey: "passportId" },
		{
			entity: "OwnershipRecord",
			direction: "inbound",
			joinKey: "petId",
			index: "byPetId",
		},
	]);
});

test("dependencies[] validates against the published schema", async () => {
	const manifest = await readJson("opensearch-projections.json");

	for (const projection of manifest.projections) {
		if (!projection.dependencies) continue;
		assertValid(validateDependencies, projection.dependencies);
	}
});

test("the dependencies schema rejects a discovery join with no index", () => {
	assert.equal(
		validateDependencies([
			{ entity: "OwnershipRecord", direction: "inbound", joinKey: "petId" },
		]),
		false,
	);
	assert.equal(
		validateDependencies([
			{ entity: "PetPassport", direction: "sideways", joinKey: "passportId" },
		]),
		false,
	);
});

test("each read operation's manifest entry carries its resolvableBy block", async () => {
	const manifest = await readJson("graphql-resolvers.json");

	const getPassport = manifest.resolvers.find(
		(x) => x.fieldName === "getPetPassport",
	);
	assert.deepEqual(getPassport.resolvableBy, {
		entity: "PetPassport",
		key: "passportId",
	});

	const listOwnership = manifest.resolvers.find(
		(x) => x.fieldName === "listOwnershipRecords",
	);
	assert.deepEqual(listOwnership.resolvableBy, {
		entity: "OwnershipRecord",
		key: "petId",
		index: "byPetId",
	});
});

test("resolvableBy blocks validate against the published schema", async () => {
	const manifest = await readJson("graphql-resolvers.json");

	const blocks = manifest.resolvers
		.map((x) => x.resolvableBy)
		.filter((x) => x !== undefined);

	assert.equal(blocks.length, 2);
	for (const block of blocks) {
		assertValid(validateResolvableBy, block);
	}
});

test("the resolvableBy schema rejects a block with no key", () => {
	assert.equal(validateResolvableBy({ entity: "PetPassport" }), false);
	assert.equal(
		validateResolvableBy({
			entity: "PetPassport",
			key: "passportId",
			extra: true,
		}),
		false,
	);
});

test("a projection with dependencies gets a typed join-resolver interface", async () => {
	const source = await readFile(
		`${EMIT_DIR}/pet-care-search-doc-join-resolver.ts`,
		"utf8",
	);

	assert.ok(
		source.includes(
			"lookupPetPassport(passportId: string): Promise<PetPassportSearchDoc | undefined>;",
		),
	);
	assert.ok(
		source.includes(
			"discoverOwnershipRecord(petId: string): Promise<OwnershipRecordSearchDoc[]>;",
		),
	);

	const barrel = await readFile(`${EMIT_DIR}/index.ts`, "utf8");
	assert.ok(
		barrel.includes(
			'export type { PetCareSearchDocJoinResolver } from "./pet-care-search-doc-join-resolver.js";',
		),
	);
});

test("the emitted join-resolver interface compiles", async () => {
	await writeFile(
		`${EMIT_DIR}/tsconfig.json`,
		JSON.stringify(
			{
				compilerOptions: {
					module: "NodeNext",
					moduleResolution: "NodeNext",
					target: "ES2020",
					strict: true,
					noEmit: true,
				},
				include: ["*.ts"],
			},
			null,
			2,
		),
	);

	await execFileAsync("npx", ["tsc", "-p", `${EMIT_DIR}/tsconfig.json`]);
});
