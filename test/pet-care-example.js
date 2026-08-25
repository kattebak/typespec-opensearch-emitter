import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

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
		{
			entity: "PetPassport",
			direction: "lookup",
			joinKey: "passportId",
			field: "passport",
		},
		{
			entity: "OwnershipRecord",
			direction: "inbound",
			joinKey: "petId",
			field: "ownershipHistory",
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

test("the dependencies schema holds the rules the diagnostics enforce", () => {
	const inboundNoIndex = {
		entity: "OwnershipRecord",
		direction: "inbound",
		joinKey: "petId",
		field: "ownershipHistory",
	};
	assert.equal(validateDependencies([inboundNoIndex]), false);

	const lookupWithIndex = {
		entity: "PetPassport",
		direction: "lookup",
		joinKey: "passportId",
		field: "passport",
		index: "byPassportId",
	};
	assert.equal(validateDependencies([lookupWithIndex]), false);

	const unboundField = {
		entity: "PetPassport",
		direction: "lookup",
		joinKey: "passportId",
	};
	assert.equal(validateDependencies([unboundField]), false);

	const strayDirection = {
		entity: "PetPassport",
		direction: "sideways",
		joinKey: "passportId",
		field: "passport",
	};
	assert.equal(validateDependencies([strayDirection]), false);
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

test("the document type carries both joined fields, lookup single-valued and inbound an array", async () => {
	const docType = await readFile(`${EMIT_DIR}/pet-care-search-doc.ts`, "utf8");

	assert.ok(docType.includes("\tpassport?: PetPassportSearchDoc;"));
	assert.ok(
		docType.includes("\townershipHistory: OwnershipRecordSearchDoc[];"),
	);
	assert.ok(
		docType.includes(
			'import type { PetPassportSearchDoc } from "./pet-passport-search-doc.js";',
		),
	);

	const barrel = await readFile(`${EMIT_DIR}/index.ts`, "utf8");
	assert.ok(
		barrel.includes(
			'export type { PetPassportSearchDoc } from "./pet-passport-search-doc.js";',
		),
	);
	assert.ok(
		barrel.includes(
			'export type { OwnershipRecordSearchDoc } from "./ownership-record-search-doc.js";',
		),
	);
});

test("the mapping carries both joined fields, nested where the projection declares it", async () => {
	const mapping = await readJson("pet-care-search-doc-search-mapping.json");
	const properties = mapping.mappings.properties;

	assert.deepEqual(properties.passport, {
		type: "object",
		properties: {
			microchipId: { type: "keyword" },
			issuedCountry: { type: "keyword" },
			vaccinations: { type: "keyword" },
		},
	});
	assert.deepEqual(properties.ownershipHistory, {
		type: "nested",
		properties: {
			ownerName: { type: "keyword" },
			transferredAt: { type: "date" },
		},
	});
});

test("the SDL response type carries both joined fields", async () => {
	const sdl = await readFile(`${EMIT_DIR}/pet-care-search-doc.graphql`, "utf8");

	assert.match(sdl, /^ {2}passport: PetPassportSearchDoc$/m);
	assert.match(sdl, /^ {2}ownershipHistory: \[OwnershipRecordSearchDoc!\]!$/m);
});

test("a joined field filters and facets like any other field of its type", async () => {
	const sdl = await readFile(`${EMIT_DIR}/pet-care-search-doc.graphql`, "utf8");

	assert.match(sdl, /^ {2}passport: PetPassportSearchFilter$/m);
	assert.match(sdl, /^ {2}ownershipHistory: OwnershipRecordSearchFilter$/m);
	assert.match(sdl, /^ {2}byPassportIssuedCountry: \[TermBucket!\]!$/m);

	const resolver = await readFile(
		`${EMIT_DIR}/pet-care-search-doc-resolver.js`,
		"utf8",
	);
	assert.ok(resolver.includes('f:"passport.issuedCountry"'));
	assert.ok(resolver.includes('f:"ownershipHistory.transferredAt"'));
	assert.ok(resolver.includes('field: "passport.issuedCountry"'));
});

// Faceting the inbound side means aggregating inside the `nested` wrapper the
// mapping opens for it, which no other case in the suite exercises.
test("an aggregation on the @nested inbound side runs inside its nested path", async () => {
	const sdl = await readFile(`${EMIT_DIR}/pet-care-search-doc.graphql`, "utf8");
	assert.match(sdl, /^ {2}byOwnershipHistoryOwnerName: \[TermBucket!\]!$/m);

	const resolver = await readFile(
		`${EMIT_DIR}/pet-care-search-doc-resolver.js`,
		"utf8",
	);
	assert.ok(
		resolver.includes(
			'{n:"byOwnershipHistoryOwnerName",g:"_ownershipHistory",p:"ownershipHistory"',
		),
	);
	assert.ok(
		resolver.includes(
			"byOwnershipHistoryOwnerName: (_a_ownershipHistory.byOwnershipHistoryOwnerName?.buckets ?? [])",
		),
	);
});

test("the manifest's fields[] carries the joined fields alongside the source ones", async () => {
	const manifest = await readJson("opensearch-projections.json");
	const petCare = manifest.projections.find(
		(x) => x.name === "PetCareSearchDoc",
	);

	assert.deepEqual(
		petCare.fields.map((x) => x.name),
		["petId", "name", "species", "passportId", "passport", "ownershipHistory"],
	);
});

test("a projection with dependencies gets a typed join-resolver interface", async () => {
	const source = await readFile(
		`${EMIT_DIR}/pet-care-search-doc-join-resolver.ts`,
		"utf8",
	);

	assert.ok(
		source.includes(
			"lookupPassport(passportId: string): Promise<PetPassportSearchDoc | undefined>;",
		),
	);
	assert.ok(
		source.includes(
			"discoverOwnershipHistory(petId: string): Promise<OwnershipRecordSearchDoc[]>;",
		),
	);

	const barrel = await readFile(`${EMIT_DIR}/index.ts`, "utf8");
	assert.ok(
		barrel.includes(
			'export type { PetCareSearchDocJoinResolver } from "./pet-care-search-doc-join-resolver.js";',
		),
	);
});

// Both joins are left joins: Waffles the beagle carries a passport and an
// ownership record, Nugget the stray carries neither, and both documents
// satisfy the emitted type.
test("the emitted types compile, an absent passport and an empty history included", async () => {
	await writeFile(
		`${EMIT_DIR}/left-join-round-trip.ts`,
		`import type { PetCareSearchDoc } from "./pet-care-search-doc.js";

export const waffles: PetCareSearchDoc = {
	petId: "waffles",
	name: "Waffles",
	species: "dog",
	passportId: "NL-01",
	passport: {
		microchipId: "982000123456789",
		issuedCountry: "NL",
		vaccinations: ["rabies"],
	},
	ownershipHistory: [
		{ ownerName: "Iris", transferredAt: "2026-03-01T00:00:00Z" },
	],
};

export const nugget: PetCareSearchDoc = {
	petId: "nugget",
	name: "Nugget",
	species: "cat",
	passportId: "",
	ownershipHistory: [],
};
`,
	);

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

// The type says the key may be absent; this runs the compose and checks it
// actually is. A left join that wrote `passport: undefined` would satisfy the
// type and still put an unmapped null in the index.
test("an unresolved lookup leaves the key off the composed document", async () => {
	await writeFile(
		`${EMIT_DIR}/left-join-compose.ts`,
		`import type { PetCareSearchDoc } from "./pet-care-search-doc.js";
import type { PetCareSearchDocJoinResolver } from "./pet-care-search-doc-join-resolver.js";

interface Pet {
	petId: string;
	name: string;
	species: string;
	passportId: string;
}

export async function compose(
	pet: Pet,
	resolver: PetCareSearchDocJoinResolver,
): Promise<PetCareSearchDoc> {
	const passport = await resolver.lookupPassport(pet.passportId);
	const ownershipHistory = await resolver.discoverOwnershipHistory(pet.petId);

	return {
		...pet,
		...(passport ? { passport } : {}),
		ownershipHistory,
	};
}
`,
	);

	await writeFile(
		`${EMIT_DIR}/tsconfig.compose.json`,
		JSON.stringify(
			{
				compilerOptions: {
					module: "NodeNext",
					moduleResolution: "NodeNext",
					target: "ES2020",
					strict: true,
					outDir: "./dist",
				},
				include: ["*.ts"],
			},
			null,
			2,
		),
	);

	await execFileAsync("npx", [
		"tsc",
		"-p",
		`${EMIT_DIR}/tsconfig.compose.json`,
	]);

	const { compose } = await import(
		pathToFileURL(`${EMIT_DIR}/dist/left-join-compose.js`).href
	);

	const nugget = await compose(
		{ petId: "nugget", name: "Nugget", species: "cat", passportId: "" },
		{
			lookupPassport: async () => undefined,
			discoverOwnershipHistory: async () => [],
		},
	);

	assert.equal("passport" in nugget, false);
	assert.deepEqual(nugget.ownershipHistory, []);

	const waffles = await compose(
		{ petId: "waffles", name: "Waffles", species: "dog", passportId: "NL-01" },
		{
			lookupPassport: async () => ({
				microchipId: "982000123456789",
				issuedCountry: "NL",
				vaccinations: ["rabies"],
			}),
			discoverOwnershipHistory: async () => [
				{ ownerName: "Iris", transferredAt: "2026-03-01T00:00:00Z" },
			],
		},
	);

	assert.equal(waffles.passport.issuedCountry, "NL");
});

test("the schemas resolve through the package exports map", async () => {
	for (const fileName of [
		"resolvable-by.schema.json",
		"dependencies.schema.json",
	]) {
		const specifier = `@kattebak/typespec-opensearch-emitter/schema/${fileName}`;
		const resolved = require.resolve(specifier);

		assert.equal(
			await readFile(resolved, "utf8"),
			await readFile(`schema/${fileName}`, "utf8"),
			`${specifier} resolves to a different file than schema/${fileName}`,
		);
	}
});

test("a sibling read over the same entity carries no resolvableBy block", async () => {
	const manifest = await readJson("graphql-resolvers.json");

	const listPassports = manifest.resolvers.find(
		(x) => x.fieldName === "listPetPassports",
	);
	assert.ok(listPassports);
	assert.equal(listPassports.resolvableBy, undefined);
});
