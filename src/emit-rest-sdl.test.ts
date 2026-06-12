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

	it("maps @graphqlId params and fields to ID (issue #136)", async () => {
		const { runner, resolved } = await resolveFixture(`
      model Pet {
        @graphqlId petId: string;
        name: string;
      }

      model CreatePetInput {
        @graphqlId ownerId: string;
        name: string;
      }

      @route("/pets")
      namespace Pets {
        @restResolver @get op getPet(@path @graphqlId petId: string): Pet;
        @restResolver @post op createPet(@body input: CreatePetInput): Pet;
        @restResolver @get op listPets(@query @graphqlId ownerId?: string): Pet[];
      }
    `);
		const [{ content }] = emitRestSdl(runner.program, resolved);

		// path param → ID! (required), optional query param → ID
		assert.ok(content.includes("getPet(petId: ID!): Pet"));
		assert.ok(content.includes("listPets(ownerId: ID): [Pet!]"));
		// the same property on object and input types maps consistently
		assert.ok(content.includes("type Pet {\n  petId: ID!\n  name: String!\n}"));
		assert.ok(
			content.includes(
				"input CreatePetInput {\n  ownerId: ID!\n  name: String!\n}",
			),
		);
	});

	it("keeps undecorated strings as String — no opt-in, no change (issue #136)", async () => {
		const { runner, resolved } = await resolveFixture(PETSTORE);
		const [{ content }] = emitRestSdl(runner.program, resolved);

		assert.ok(content.includes("getPet(petId: String!): Pet"));
		assert.ok(content.includes("type Pet {\n  petId: String!"));
		assert.ok(!content.includes("ID"));
	});

	it("maps int64 to Float in object, input, and arg positions to avoid 32-bit Int overflow (issue #138)", async () => {
		const { runner, resolved } = await resolveFixture(`
      model Pet {
        petId: string;
        createdAt: int64;
      }

      model CreatePetInput {
        createdAt: int64;
      }

      @route("/pets")
      namespace Pets {
        @restResolver @get op getPet(@path petId: string): Pet;
        @restResolver @post op createPet(@body input: CreatePetInput): Pet;
        @restResolver @get op listPets(@query since?: int64): Pet[];
      }
    `);
		const [{ content }] = emitRestSdl(runner.program, resolved);

		assert.ok(
			content.includes("type Pet {\n  petId: String!\n  createdAt: Float!\n}"),
		);
		assert.ok(
			content.includes("input CreatePetInput {\n  createdAt: Float!\n}"),
		);
		assert.ok(content.includes("listPets(since: Float): [Pet!]"));
	});

	it("maps safeint to Float like int64 (issue #138)", async () => {
		const { runner, resolved } = await resolveFixture(`
      model Pet { count: safeint; }

      @route("/pets")
      namespace Pets {
        @restResolver @get op getPet(@path petId: string): Pet;
      }
    `);
		const [{ content }] = emitRestSdl(runner.program, resolved);

		assert.ok(content.includes("type Pet {\n  count: Float!\n}"));
	});

	it("keeps int32 and integer as Int — only 64-bit-capable scalars are remapped (issue #138)", async () => {
		const { runner, resolved } = await resolveFixture(`
      model Pet {
        age: int32;
        weight: integer;
      }

      @route("/pets")
      namespace Pets {
        @restResolver @get op getPet(@path petId: string): Pet;
      }
    `);
		const [{ content }] = emitRestSdl(runner.program, resolved);

		assert.ok(content.includes("type Pet {\n  age: Int!\n  weight: Int!\n}"));
	});

	it("maps Record<T> properties to AWSJSON scalar (issue #141)", async () => {
		const { runner, resolved } = await resolveFixture(`
      model Pet {
        petId: string;
        metadata: Record<unknown>;
      }

      @route("/pets")
      namespace Pets {
        @restResolver @get op getPet(@path petId: string): Pet;
      }
    `);
		const [{ content }] = emitRestSdl(runner.program, resolved);

		assert.ok(content.includes("  metadata: AWSJSON!"));
		// Record should not be emitted as a named type
		assert.ok(!content.includes("type Record"));
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

	it("sdlFileName option: all ops in one file", async () => {
		const MULTI_MODEL = `
      model Pet {
        petId: string;
        name: string;
      }

      model Order {
        orderId: string;
        qty: int32;
      }

      @route("/pets")
      namespace Pets {
        @restResolver @get op getPet(@path petId: string): Pet;
      }

      @route("/orders")
      namespace Orders {
        @restResolver @post op createOrder(@body input: Order): Order;
      }
    `;

		const { runner, resolved } = await resolveFixture(MULTI_MODEL);
		const files = emitRestSdl(runner.program, resolved, {
			sdlFileName: "all.graphql",
		});

		assert.equal(files.length, 1);
		assert.equal(files[0].fileName, "all.graphql");

		const { content } = files[0];
		// Both operations in the same Query/Mutation block
		assert.ok(content.includes("type Query {"));
		assert.ok(content.includes("  getPet(petId: String!): Pet"));
		assert.ok(content.includes("type Mutation {"));
		assert.ok(content.includes("  createOrder(input: Order!): Order"));

		// Each shared type appears exactly once
		assert.equal((content.match(/type Pet \{/g) ?? []).length, 1);
		assert.equal((content.match(/input Order \{/g) ?? []).length, 1);
	});

	it("sdlFileName option: shared types deduplicated across operations", async () => {
		const { runner, resolved } = await resolveFixture(PETSTORE);
		const files = emitRestSdl(runner.program, resolved, {
			sdlFileName: "pets.graphql",
		});

		assert.equal(files.length, 1);
		assert.equal(files[0].fileName, "pets.graphql");

		const { content } = files[0];
		// Pet, PetStatus and CreatePetInput each appear exactly once
		assert.equal((content.match(/type Pet \{/g) ?? []).length, 1);
		assert.equal((content.match(/enum PetStatus \{/g) ?? []).length, 1);
		assert.equal((content.match(/input CreatePetInput \{/g) ?? []).length, 1);
	});

	it("without sdlFileName option, backward-compat per-model grouping is preserved", async () => {
		const { runner, resolved } = await resolveFixture(PETSTORE);
		// All ops return Pet so they still land in pet.graphql
		const files = emitRestSdl(runner.program, resolved);

		assert.equal(files.length, 1);
		assert.equal(files[0].fileName, "pet.graphql");
	});
});
