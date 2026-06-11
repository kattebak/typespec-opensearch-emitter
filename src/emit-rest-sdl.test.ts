import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emitRestSdl, restSdlFileName } from "./emit-rest-sdl.js";
import { resolveFixture } from "./rest-operations.test.js";

const PETSTORE = `
  model Pet {
    petId: string;
    name: string;
    status: PetStatus;
  }

  enum PetStatus { Available, Pending, Sold }

  model CreatePetInput {
    name: string;
    status: PetStatus;
  }

  @route("/pets")
  namespace Pets {
    @restResolver @get op getPet(@path petId: string): Pet;
    @restResolver @post op createPet(@body input: CreatePetInput): Pet;
    @restResolver @get op listPets(@query status?: string): Pet[];
  }
`;

describe("emitRestSdl", () => {
	it("groups operations per return model into <model>.graphql", async () => {
		const { runner, resolved } = await resolveFixture(PETSTORE);
		const files = emitRestSdl(runner.program, resolved);

		assert.deepEqual(
			files.map((f) => f.fileName),
			["pet.graphql"],
		);
		for (const op of resolved) {
			assert.equal(restSdlFileName(op), "pet.graphql");
		}
	});

	it("puts GET fields under type Query and other verbs under type Mutation", async () => {
		const { runner, resolved } = await resolveFixture(PETSTORE);
		const [{ content }] = emitRestSdl(runner.program, resolved);

		assert.ok(content.includes("type Query {"));
		assert.ok(content.includes("  getPet(petId: String!): Pet"));
		assert.ok(content.includes("type Mutation {"));
		assert.ok(content.includes("  createPet(input: CreatePetInput!): Pet"));
	});

	it("renders path params as required args and query params per optionality", async () => {
		const { runner, resolved } = await resolveFixture(PETSTORE);
		const [{ content }] = emitRestSdl(runner.program, resolved);

		// @path → required
		assert.ok(content.includes("getPet(petId: String!)"));
		// optional @query → nullable arg; array return maps via shared helper
		assert.ok(content.includes("listPets(status: String): [Pet!]"));
	});

	it("derives a GraphQL input type from the @body model", async () => {
		const { runner, resolved } = await resolveFixture(PETSTORE);
		const [{ content }] = emitRestSdl(runner.program, resolved);

		assert.ok(
			content.includes(
				"input CreatePetInput {\n  name: String!\n  status: PetStatus!\n}",
			),
		);
	});

	it("maps the return model to a GraphQL object type via the shared type mapping", async () => {
		const { runner, resolved } = await resolveFixture(PETSTORE);
		const [{ content }] = emitRestSdl(runner.program, resolved);

		assert.ok(
			content.includes(
				"type Pet {\n  petId: String!\n  name: String!\n  status: PetStatus!\n}",
			),
		);
	});

	it("emits referenced enums as GraphQL enums", async () => {
		const { runner, resolved } = await resolveFixture(PETSTORE);
		const [{ content }] = emitRestSdl(runner.program, resolved);

		assert.ok(
			content.includes("enum PetStatus {\n  Available\n  Pending\n  Sold\n}"),
		);
	});

	it("renders required @query params with a bang", async () => {
		const { runner, resolved } = await resolveFixture(`
      model Pet { petId: string; }

      @route("/pets")
      namespace Pets {
        @restResolver @get op listPets(@query limit: int32): Pet[];
      }
    `);
		const [{ content }] = emitRestSdl(runner.program, resolved);
		assert.ok(content.includes("listPets(limit: Int!): [Pet!]"));
	});
});
