import type {
	Enum,
	Model,
	ModelProperty,
	Program,
	Type,
} from "@typespec/compiler";
import { isGraphqlId } from "./decorators.js";
import { toGraphQLType } from "./graphql-types.js";
import type { ResolvedRestOperation } from "./rest-operations.js";
import { toKebabCase } from "./utils.js";

/**
 * GraphQL SDL codegen for `@restResolver` operations (issue #134). GET
 * operations become `type Query` fields, the other verbs become
 * `type Mutation` fields. `@path` params are required args, `@query` params
 * follow their TypeSpec optionality, a `@body` model becomes a generated
 * GraphQL `input` type. Scalar mapping is shared with the OpenSearch SDL
 * path (graphql-types.ts).
 *
 * Operations are grouped per return model — both `getPet` and `createPet`
 * returning `Pet` land in `pet.graphql` together with the types they need.
 */

export interface EmittedRestSdlFile {
	fileName: string;
	content: string;
}

/** Manifest `sdlFile` for an operation — the file its group renders into. */
export function restSdlFileName(op: ResolvedRestOperation): string {
	return `${toKebabCase(groupName(op))}.graphql`;
}

export interface EmitRestSdlOptions {
	/**
	 * When set, all operations collapse into one file with this name and a
	 * shared type registry. Manifest entries all point at this file. Issue #142.
	 */
	sdlFileName?: string;
}

export function emitRestSdl(
	program: Program,
	operations: ResolvedRestOperation[],
	options?: EmitRestSdlOptions,
): EmittedRestSdlFile[] {
	if (options?.sdlFileName) {
		return [
			{
				fileName: options.sdlFileName,
				content: renderGroup(program, operations),
			},
		];
	}

	const groups = new Map<string, ResolvedRestOperation[]>();
	for (const op of operations) {
		const fileName = restSdlFileName(op);
		const group = groups.get(fileName) ?? [];
		group.push(op);
		groups.set(fileName, group);
	}

	const files: EmittedRestSdlFile[] = [];
	for (const [fileName, group] of groups) {
		files.push({ fileName, content: renderGroup(program, group) });
	}
	return files;
}

/** Group key: the (unwrapped) return model name, falling back to the field name. */
function groupName(op: ResolvedRestOperation): string {
	const model = unwrapModel(op.returnType);
	return model?.name ?? op.fieldName;
}

function unwrapModel(type: Type): Model | undefined {
	if (type.kind !== "Model") return undefined;
	if (type.name === "Array" && type.indexer?.value) {
		return unwrapModel(type.indexer.value);
	}
	return type.name ? type : undefined;
}

interface TypeRegistry {
	objects: Map<string, Model>;
	inputs: Map<string, Model>;
	enums: Map<string, Enum>;
}

function renderGroup(
	program: Program,
	operations: ResolvedRestOperation[],
): string {
	const registry: TypeRegistry = {
		objects: new Map(),
		inputs: new Map(),
		enums: new Map(),
	};

	const queryFields: string[] = [];
	const mutationFields: string[] = [];
	for (const op of operations) {
		const field = renderField(program, op, registry);
		(op.typeName === "Query" ? queryFields : mutationFields).push(field);
	}

	const blocks: string[] = [];
	for (const model of registry.objects.values()) {
		blocks.push(renderModelBlock(program, model, "type", registry));
	}
	for (const enumType of registry.enums.values()) {
		blocks.push(renderEnumBlock(enumType));
	}
	for (const model of registry.inputs.values()) {
		blocks.push(renderModelBlock(program, model, "input", registry));
	}
	if (queryFields.length > 0) {
		blocks.push(`type Query {\n${queryFields.join("\n")}\n}`);
	}
	if (mutationFields.length > 0) {
		blocks.push(`type Mutation {\n${mutationFields.join("\n")}\n}`);
	}

	return `${blocks.join("\n\n")}\n`;
}

function renderField(
	program: Program,
	op: ResolvedRestOperation,
	registry: TypeRegistry,
): string {
	const args: string[] = [];
	for (const param of op.pathParams) {
		const gqlType = param.property
			? restPropertyRef(program, param.property, registry, "object")
			: "String";
		args.push(`${param.name}: ${gqlType}!`);
	}
	for (const param of op.queryParams) {
		const gqlType = param.property
			? restPropertyRef(program, param.property, registry, "object")
			: "String";
		args.push(`${param.name}: ${gqlType}${param.optional ? "" : "!"}`);
	}
	if (op.bodyParamName && op.bodyModel) {
		const inputType = restTypeRef(program, op.bodyModel, registry, "input");
		args.push(`${op.bodyParamName}: ${inputType}!`);
	}

	const returnRef = restTypeRef(program, op.returnType, registry, "object");
	const argList = args.length > 0 ? `(${args.join(", ")})` : "";
	return `  ${op.fieldName}${argList}: ${returnRef}`;
}

/**
 * Property-aware type reference: `@graphqlId` (issue #136) is an opt-in on
 * the ModelProperty, so it can only be honored where the property is known —
 * operation args and object/input fields. Undecorated properties defer to
 * restTypeRef unchanged, keeping default output byte-identical.
 */
function restPropertyRef(
	program: Program,
	property: ModelProperty,
	registry: TypeRegistry,
	position: "object" | "input",
): string {
	if (isGraphqlId(program, property)) {
		return "ID";
	}
	return restTypeRef(program, property.type, registry, position);
}

/**
 * Type reference for REST SDL: named models and enums become named GraphQL
 * types registered for emission (object or input position); everything else
 * defers to the shared scalar mapping.
 */
function restTypeRef(
	program: Program,
	type: Type,
	registry: TypeRegistry,
	position: "object" | "input",
): string {
	if (type.kind === "Enum") {
		registry.enums.set(type.name, type);
		return type.name;
	}
	if (type.kind === "Model" && type.name === "Array" && type.indexer?.value) {
		const element = restTypeRef(
			program,
			type.indexer.value,
			registry,
			position,
		);
		return `[${element}!]`;
	}
	if (
		type.kind === "Model" &&
		type.name === "Record" &&
		type.indexer?.value &&
		type.properties.size === 0
	) {
		return "AWSJSON";
	}
	if (type.kind === "Model" && type.name) {
		registerModel(program, type, registry, position);
		return type.name;
	}
	return toGraphQLType(program, type, undefined, "rest");
}

function registerModel(
	program: Program,
	model: Model,
	registry: TypeRegistry,
	position: "object" | "input",
): void {
	const target = position === "input" ? registry.inputs : registry.objects;
	if (target.has(model.name)) return;
	target.set(model.name, model);
	// Walk properties so referenced models/enums are registered too.
	for (const property of model.properties.values()) {
		restTypeRef(program, property.type, registry, position);
	}
}

function renderModelBlock(
	program: Program,
	model: Model,
	keyword: "type" | "input",
	registry: TypeRegistry,
): string {
	const position = keyword === "input" ? "input" : "object";
	const fieldLines = [...model.properties.values()].map((property) => {
		const gqlType = restPropertyRef(program, property, registry, position);
		const nullable = property.optional ? "" : "!";
		return `  ${property.name}: ${gqlType}${nullable}`;
	});
	return `${keyword} ${model.name} {\n${fieldLines.join("\n")}\n}`;
}

function renderEnumBlock(enumType: Enum): string {
	const memberLines = [...enumType.members.values()].map(
		(member) => `  ${member.name}`,
	);
	return `enum ${enumType.name} {\n${memberLines.join("\n")}\n}`;
}

export const __test = {
	groupName,
	renderGroup,
	renderField,
	restPropertyRef,
	restTypeRef,
};
