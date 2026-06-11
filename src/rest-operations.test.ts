import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTestHost, createTestWrapper } from "@typespec/compiler/testing";
import { HttpTestLibrary } from "@typespec/http/testing";
import {
	collectRestOperations,
	resolveRestOperation,
	toRestGraphQLTypeName,
} from "./rest-operations.js";
import { OpenSearchEmitterTestLibrary } from "./testing/index.js";

export async function createRestRunner() {
	const host = await createTestHost({
		libraries: [HttpTestLibrary, OpenSearchEmitterTestLibrary],
	});

	return createTestWrapper(host, {
		autoImports: ["@typespec/http", "@kattebak/typespec-opensearch-emitter"],
		autoUsings: ["TypeSpec.Http", "Kattebak.OpenSearch"],
	});
}

export async function resolveFixture(code: string) {
	const runner = await createRestRunner();
	const diagnostics = await runner.diagnose(code);
	const errors = diagnostics.filter((d) => d.severity === "error");
	assert.deepEqual(errors, []);
	const operations = collectRestOperations(
		runner.program,
		runner.program.getGlobalNamespaceType(),
	);
	return {
		runner,
		operations,
		resolved: operations.map((op) => resolveRestOperation(runner.program, op)),
	};
}

describe("toRestGraphQLTypeName (verb → GraphQL type)", () => {
	it("maps GET to Query and every other verb to Mutation", () => {
		assert.equal(toRestGraphQLTypeName("get"), "Query");
		assert.equal(toRestGraphQLTypeName("post"), "Mutation");
		assert.equal(toRestGraphQLTypeName("put"), "Mutation");
		assert.equal(toRestGraphQLTypeName("patch"), "Mutation");
		assert.equal(toRestGraphQLTypeName("delete"), "Mutation");
	});
});

describe("collectRestOperations", () => {
	it("collects only operations marked @restResolver", async () => {
		const { operations } = await resolveFixture(`
      model Pet { petId: string; }

      @route("/pets")
      namespace Pets {
        @restResolver @get op getPet(@path petId: string): Pet;
        @get op ignored(@path petId: string): Pet;
      }
    `);

		assert.deepEqual(
			operations.map((op) => op.name),
			["getPet"],
		);
	});

	it("collects operations from interfaces and nested namespaces", async () => {
		const { operations } = await resolveFixture(`
      model Pet { petId: string; }

      namespace Api {
        @route("/pets")
        interface Pets {
          @restResolver @get getPet(@path petId: string): Pet;
        }
      }
    `);

		assert.deepEqual(
			operations.map((op) => op.name),
			["getPet"],
		);
	});
});

describe("resolveRestOperation", () => {
	it("resolves verb, route, and path params for a GET", async () => {
		const { resolved } = await resolveFixture(`
      model Pet { petId: string; }

      @route("/pets")
      namespace Pets {
        @restResolver @get op getPet(@path petId: string): Pet;
      }
    `);

		const [getPet] = resolved;
		assert.equal(getPet.typeName, "Query");
		assert.equal(getPet.httpMethod, "GET");
		assert.equal(getPet.path, "/pets/{petId}");
		assert.deepEqual(
			getPet.pathParams.map((p) => p.name),
			["petId"],
		);
		assert.equal(getPet.queryParams.length, 0);
		assert.equal(getPet.bodyParamName, undefined);
	});

	it("resolves the @body model and its parameter name", async () => {
		const { resolved } = await resolveFixture(`
      model Pet { petId: string; }
      model CreatePetInput { name: string; }

      @route("/pets")
      namespace Pets {
        @restResolver @post op createPet(@body input: CreatePetInput): Pet;
      }
    `);

		const [createPet] = resolved;
		assert.equal(createPet.typeName, "Mutation");
		assert.equal(createPet.httpMethod, "POST");
		assert.equal(createPet.bodyParamName, "input");
		assert.equal(createPet.bodyModel?.name, "CreatePetInput");
	});

	it("resolves @query params with their optionality", async () => {
		const { resolved } = await resolveFixture(`
      model Pet { petId: string; }

      @route("/pets")
      namespace Pets {
        @restResolver @get op listPets(@query status?: string, @query limit: int32): Pet[];
      }
    `);

		const [listPets] = resolved;
		assert.deepEqual(
			listPets.queryParams.map((p) => ({ name: p.name, optional: p.optional })),
			[
				{ name: "status", optional: true },
				{ name: "limit", optional: false },
			],
		);
	});

	it("maps PUT/PATCH/DELETE to Mutation", async () => {
		const { resolved } = await resolveFixture(`
      model Pet { petId: string; }
      model UpdatePetInput { name: string; }

      @route("/pets")
      namespace Pets {
        @restResolver @put op replacePet(@path petId: string, @body input: UpdatePetInput): Pet;
        @restResolver @patch(#{ implicitOptionality: false }) op updatePet(@path petId: string, @body input: UpdatePetInput): Pet;
        @restResolver @delete op deletePet(@path petId: string): Pet;
      }
    `);

		assert.deepEqual(
			resolved.map((op) => [op.fieldName, op.typeName, op.httpMethod]),
			[
				["replacePet", "Mutation", "PUT"],
				["updatePet", "Mutation", "PATCH"],
				["deletePet", "Mutation", "DELETE"],
			],
		);
	});
});
