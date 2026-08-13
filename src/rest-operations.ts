import type {
	Model,
	ModelProperty,
	Namespace,
	Operation,
	Program,
	Type,
} from "@typespec/compiler";
import { getHttpOperation } from "@typespec/http";
import { isRestResolver } from "./decorators.js";

/**
 * Discovery + resolution for `@restResolver` operations (issue #134). This is
 * the REST counterpart of the model walk in emitter.ts: it collects every
 * operation carrying `@restResolver` and resolves its HTTP metadata (verb,
 * route, path/query params, body, return type) via `@typespec/http`.
 * Deliberately a separate module — the OpenSearch path stays untouched.
 */

export type RestGraphQLTypeName = "Query" | "Mutation";

export interface RestPathParam {
	name: string;
	/** Source ModelProperty — used by the SDL emitter for arg typing. */
	property?: ModelProperty;
}

export interface RestQueryParam {
	name: string;
	optional: boolean;
	/** The parameter is array-typed, so it serializes to more than one value. */
	array: boolean;
	/**
	 * RFC-6570 explode, as resolved by `@typespec/http`. An exploded array
	 * repeats the key (`?s=a&s=b`); a non-exploded one joins on a comma.
	 */
	explode: boolean;
	/** Source ModelProperty — used by the SDL emitter for arg typing. */
	property?: ModelProperty;
}

/**
 * The renderer-facing shape: plain data, no compiler types. Everything
 * emit-rest-resolver.ts needs to render a request/response template.
 */
export interface RestOperationShape {
	/** Operation name verbatim — becomes the GraphQL field name. */
	fieldName: string;
	/** "Query" for GET, "Mutation" for POST/PUT/PATCH/DELETE. */
	typeName: RestGraphQLTypeName;
	/** Upper-cased HTTP verb, e.g. "GET". */
	httpMethod: string;
	/** Resolved route path with `{param}` placeholders, e.g. "/pets/{petId}". */
	path: string;
	pathParams: RestPathParam[];
	queryParams: RestQueryParam[];
	/** Name of the `@body` parameter (the GraphQL `input` arg), if present. */
	bodyParamName?: string;
}

export interface ResolvedRestOperation extends RestOperationShape {
	operation: Operation;
	/** The `@body` model, when the operation declares one. */
	bodyModel?: Model;
	/** The operation's declared return type. */
	returnType: Type;
}

export function collectRestOperations(
	program: Program,
	namespace: Namespace,
): Operation[] {
	const operations: Operation[] = [];

	for (const operation of namespace.operations.values()) {
		if (isRestResolver(program, operation)) {
			operations.push(operation);
		}
	}

	for (const iface of namespace.interfaces.values()) {
		for (const operation of iface.operations.values()) {
			if (isRestResolver(program, operation)) {
				operations.push(operation);
			}
		}
	}

	for (const child of namespace.namespaces.values()) {
		operations.push(...collectRestOperations(program, child));
	}

	return operations;
}

export function toRestGraphQLTypeName(verb: string): RestGraphQLTypeName {
	return verb.toLowerCase() === "get" ? "Query" : "Mutation";
}

function isArrayType(type: Type): boolean {
	return (
		type.kind === "Model" &&
		type.name === "Array" &&
		type.indexer?.value !== undefined
	);
}

export function resolveRestOperation(
	program: Program,
	operation: Operation,
): ResolvedRestOperation {
	const [httpOperation] = getHttpOperation(program, operation);

	const pathParams: RestPathParam[] = [];
	const queryParams: RestQueryParam[] = [];
	for (const parameter of httpOperation.parameters.parameters) {
		if (parameter.type === "path") {
			pathParams.push({ name: parameter.name, property: parameter.param });
		} else if (parameter.type === "query") {
			queryParams.push({
				name: parameter.name,
				optional: parameter.param.optional,
				array: isArrayType(parameter.param.type),
				explode: parameter.explode,
				property: parameter.param,
			});
		}
	}

	const body = httpOperation.parameters.body;
	const bodyModel =
		body && body.bodyKind === "single" && body.type.kind === "Model"
			? body.type
			: undefined;
	const bodyParamName = bodyModel
		? (body?.property?.name ?? "input")
		: undefined;

	return {
		fieldName: operation.name,
		typeName: toRestGraphQLTypeName(httpOperation.verb),
		httpMethod: httpOperation.verb.toUpperCase(),
		path: httpOperation.path,
		pathParams,
		queryParams,
		bodyParamName,
		bodyModel,
		returnType: operation.returnType,
		operation,
	};
}
