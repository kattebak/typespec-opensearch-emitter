import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_ERROR_MAP,
	emitRestResolver,
	restResolverFileName,
} from "./emit-rest-resolver.js";
import type { RestOperationShape } from "./rest-operations.js";

const getPet: RestOperationShape = {
	fieldName: "getPet",
	typeName: "Query",
	httpMethod: "GET",
	path: "/pets/{petId}",
	pathParams: [{ name: "petId" }],
	queryParams: [],
};

const createPet: RestOperationShape = {
	fieldName: "createPet",
	typeName: "Mutation",
	httpMethod: "POST",
	path: "/pets",
	pathParams: [],
	queryParams: [],
	bodyParamName: "input",
};

const listPets: RestOperationShape = {
	fieldName: "listPets",
	typeName: "Query",
	httpMethod: "GET",
	path: "/pets",
	pathParams: [],
	queryParams: [{ name: "status", optional: true }],
};

describe("restResolverFileName", () => {
	it("names files <TypeName>.<fieldName>.js", () => {
		assert.equal(restResolverFileName(getPet), "Query.getPet.js");
		assert.equal(restResolverFileName(createPet), "Mutation.createPet.js");
	});
});

describe("emitRestResolver request rendering", () => {
	it("interpolates path params into resourcePath via util.urlEncode", () => {
		const { content } = emitRestResolver(getPet);
		assert.ok(content.includes('method: "GET"'));
		assert.ok(
			content.includes(
				"resourcePath: `/pets/${util.urlEncode(ctx.args.petId)}`",
			),
		);
	});

	it("interpolates multiple path params", () => {
		const { content } = emitRestResolver({
			...getPet,
			path: "/owners/{ownerId}/pets/{petId}",
			pathParams: [{ name: "ownerId" }, { name: "petId" }],
		});
		assert.ok(
			content.includes(
				"resourcePath: `/owners/${util.urlEncode(ctx.args.ownerId)}/pets/${util.urlEncode(ctx.args.petId)}`",
			),
		);
	});

	it("renders a plain string resourcePath when there are no path params", () => {
		const { content } = emitRestResolver(createPet);
		assert.ok(content.includes('resourcePath: "/pets"'));
	});

	it("serializes the body arg for mutations", () => {
		const { content } = emitRestResolver(createPet);
		assert.ok(content.includes('method: "POST"'));
		assert.ok(content.includes("body: JSON.stringify(ctx.args.input)"));
	});

	it("places query params in params.query", () => {
		const { content } = emitRestResolver(listPets);
		assert.ok(content.includes('"status": ctx.args.status'));
		assert.ok(content.includes("query: {"));
	});

	it("omits query and body blocks when neither is present", () => {
		const { content } = emitRestResolver(getPet);
		assert.ok(content.includes("params: { headers: BASE_HEADERS(ctx) }"));
		assert.ok(!content.includes("query: {"));
		assert.ok(!content.includes("JSON.stringify"));
	});

	it("prepends resourcePathPrefix to path params template literal (issue #140)", () => {
		const { content } = emitRestResolver(getPet, {
			resourcePathPrefix: "/api/v1",
		});
		assert.ok(
			content.includes(
				"resourcePath: `/api/v1/pets/${util.urlEncode(ctx.args.petId)}`",
			),
		);
	});

	it("prepends resourcePathPrefix to plain string resourcePath (issue #140)", () => {
		const { content } = emitRestResolver(createPet, {
			resourcePathPrefix: "/api/v1",
		});
		assert.ok(content.includes('resourcePath: "/api/v1/pets"'));
	});

	it("leaves resourcePath unchanged when no prefix given (issue #140)", () => {
		const { content } = emitRestResolver(createPet);
		assert.ok(content.includes('resourcePath: "/pets"'));
	});
});

describe("emitRestResolver header injection", () => {
	it("defaults to Content-Type only", () => {
		const { content } = emitRestResolver(getPet);
		assert.ok(
			content.includes(
				'const BASE_HEADERS = (ctx) => ({\n\t"Content-Type": "application/json",\n});',
			),
		);
	});

	it("expands injectHeaders into BASE_HEADERS as dotted ctx paths", () => {
		const { content } = emitRestResolver(getPet, {
			injectHeaders: { "x-user-id": "identity.resolverContext.userId" },
		});
		assert.ok(
			content.includes('"x-user-id": ctx.identity.resolverContext.userId,'),
		);
		assert.ok(content.includes('"Content-Type": "application/json",'));
	});

	it("rejects ctx paths that are not dotted identifiers", () => {
		assert.throws(
			() =>
				emitRestResolver(getPet, {
					injectHeaders: { "x-evil": "identity}); doEvil(" },
				}),
			/not a valid dotted ctx path/,
		);
	});
});

describe("emitRestResolver error mapping", () => {
	it("maps 409/403 by default and falls through to Http<status>", () => {
		const { content } = emitRestResolver(getPet);
		assert.ok(
			content.includes(
				'if (statusCode === 409) util.error(parsed?.message ?? body, "ConflictError");',
			),
		);
		assert.ok(
			content.includes(
				'if (statusCode === 403) util.error(parsed?.message ?? body, "ForbiddenError");',
			),
		);
		assert.ok(
			content.includes(
				"util.error(parsed?.message ?? body, `Http${statusCode}`, parsed);",
			),
		);
	});

	it("returns the parsed body on 2xx", () => {
		const { content } = emitRestResolver(getPet);
		assert.ok(
			content.includes(
				"if (statusCode >= 200 && statusCode < 300) return parsed;",
			),
		);
	});

	it("merges rest.errorMap over the default per-status mapping", () => {
		const { content } = emitRestResolver(getPet, {
			errorMap: { "404": "NotFoundError", "409": "PetConflict" },
		});
		assert.ok(
			content.includes(
				'if (statusCode === 404) util.error(parsed?.message ?? body, "NotFoundError");',
			),
		);
		// Overridden status wins...
		assert.ok(
			content.includes(
				'if (statusCode === 409) util.error(parsed?.message ?? body, "PetConflict");',
			),
		);
		// ...while untouched defaults survive.
		assert.ok(content.includes('"ForbiddenError"'));
		assert.ok(!content.includes('"ConflictError"'));
	});

	it("ships the documented default map", () => {
		assert.deepEqual(DEFAULT_ERROR_MAP, {
			"409": "ConflictError",
			"403": "ForbiddenError",
		});
	});
});

describe("emitRestResolver APPSYNC_JS validity", () => {
	it("emits no async/await and imports only @aws-appsync/utils", () => {
		for (const op of [getPet, createPet, listPets]) {
			const { content } = emitRestResolver(op);
			assert.ok(
				content.startsWith('import { util } from "@aws-appsync/utils";'),
			);
			assert.ok(!content.includes("async "));
			assert.ok(!content.includes("await "));
			assert.ok(content.includes("export function request(ctx) {"));
			assert.ok(content.includes("export function response(ctx) {"));
		}
	});
});
