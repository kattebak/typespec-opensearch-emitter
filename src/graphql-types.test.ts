import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Program, Scalar, Type } from "@typespec/compiler";
import { type GraphQLEmitContext, toGraphQLType } from "./graphql-types.js";

const dummyProgram = {} as unknown as Program;

function scalar(name: string): Type {
	return { kind: "Scalar", name } as unknown as Type;
}

function map(name: string, context: GraphQLEmitContext): string {
	return toGraphQLType(dummyProgram, scalar(name), undefined, context);
}

describe("scalarToGraphQL 64-bit integer mapping", () => {
	it("maps int64/uint64 response to Float (avoids Int32 overflow at AppSync response coercion)", () => {
		assert.equal(map("int64", "response"), "Float");
		assert.equal(map("uint64", "response"), "Float");
	});

	it("maps int64/uint64 rest to Float", () => {
		assert.equal(map("int64", "rest"), "Float");
		assert.equal(map("uint64", "rest"), "Float");
	});

	it("maps int64/uint64 filter to String (64-bit values can exceed 2^53)", () => {
		assert.equal(map("int64", "filter"), "String");
		assert.equal(map("uint64", "filter"), "String");
	});

	it("maps safeint response and rest to Float", () => {
		assert.equal(map("safeint", "response"), "Float");
		assert.equal(map("safeint", "rest"), "Float");
	});

	it("keeps int32 as Int across contexts", () => {
		assert.equal(map("int32", "response"), "Int");
		assert.equal(map("int32", "filter"), "Int");
		assert.equal(map("int32", "rest"), "Int");
	});
});
