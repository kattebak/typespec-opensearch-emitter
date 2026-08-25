import type {
	Model,
	ModelProperty,
	Namespace,
	Operation,
	Program,
	Type,
} from "@typespec/compiler";
import { getHttpOperation } from "@typespec/http";
import {
	getJoinDependencies,
	getResolvableBy,
	isRestResolver,
	isSearchable,
	isSearchInfer,
} from "./decorators.js";
import { reportDiagnostic } from "./lib.js";
import {
	getProjectionSourceModel,
	isSearchProjectionModel,
} from "./projection.js";

export const JOIN_DIRECTIONS = ["lookup", "inbound"] as const;
export type JoinDirection = (typeof JOIN_DIRECTIONS)[number];

export function isJoinDirection(value: string): value is JoinDirection {
	return (JOIN_DIRECTIONS as readonly string[]).includes(value);
}

export interface ResolvableByDeclaration {
	key: ModelProperty;
	index?: string;
}

export interface JoinDependencyDeclaration {
	entity: Model;
	direction: string;
	joinKey: ModelProperty;
}

export interface ResolvedJoinDependency {
	entity: Model;
	direction: JoinDirection;
	joinKey: ModelProperty;
	/**
	 * The projection property the joined value lands in. Its declared type is
	 * what the join resolver returns.
	 */
	field: ModelProperty;
	/** Carried from the entity's `@resolvableBy`; an inbound join only. */
	index?: string;
}

export interface ResolvableByManifestEntry {
	entity: string;
	key: string;
	index?: string;
}

export interface JoinDependencyManifestEntry {
	entity: string;
	direction: JoinDirection;
	joinKey: string;
	field: string;
	index?: string;
}

/**
 * The model a join key must belong to: its own model for `@resolvableBy`, the
 * projection's source model for a `lookup` (the driving row carries the value
 * the joined row is fetched by), and the joined entity for an `inbound` (the
 * joined row carries the reference back).
 */
function expectedJoinKeyOwner(
	declaration: JoinDependencyDeclaration,
	sourceModel: Model,
): Model {
	return declaration.direction === "inbound" ? declaration.entity : sourceModel;
}

/**
 * True when the property is declared on the model or on anything it extends.
 * An inherited property keeps the base model in `.model`, so identity alone
 * rejects a key a derived model legitimately owns.
 */
export function ownsProperty(model: Model, property: ModelProperty): boolean {
	for (
		let current: Model | undefined = model;
		current;
		current = current.baseModel
	) {
		if (property.model === current) {
			return true;
		}
	}
	return false;
}

export function unwrapArrayElement(type: Type): Type | undefined {
	if (type.kind === "Model" && type.name === "Array") {
		return type.indexer?.value;
	}
	return undefined;
}

/**
 * True when the type names the joined entity, either directly or through a
 * `SearchProjection<Entity>` document.
 */
function receivesEntity(program: Program, type: Type, entity: Model): boolean {
	if (type.kind !== "Model") {
		return false;
	}
	return type === entity || getProjectionSourceModel(program, type) === entity;
}

/**
 * The projection properties a declaration could fill. A declaration fills
 * exactly one; anything else is reported rather than guessed at.
 */
export function candidateJoinFields(
	program: Program,
	projectionModel: Model,
	entity: Model,
): ModelProperty[] {
	return [...projectionModel.properties.values()].filter((property) => {
		const element = unwrapArrayElement(property.type);
		return receivesEntity(program, element ?? property.type, entity);
	});
}

/**
 * True when something states which of the joined entity enters the document
 * (issue #195): a `SearchProjection<T>` document, a `@searchInfer` model whose
 * fields the emitter derives, or a plain model with `@searchable` properties.
 * A model offering none of the three composes into an empty object, which the
 * mapping and the SDL cannot express.
 */
export function composesIntoDocument(
	program: Program,
	field: ModelProperty,
): boolean {
	const joined = unwrapArrayElement(field.type) ?? field.type;
	if (joined.kind !== "Model") {
		return false;
	}
	if (
		isSearchProjectionModel(program, joined) ||
		isSearchInfer(program, joined)
	) {
		return true;
	}
	return [...joined.properties.values()].some((property) =>
		isSearchable(program, property),
	);
}

export function resolveJoinDependencies(
	program: Program,
	projectionModel: Model,
): ResolvedJoinDependency[] {
	const resolved: ResolvedJoinDependency[] = [];
	for (const declaration of getJoinDependencies(program, projectionModel)) {
		if (!isJoinDirection(declaration.direction)) {
			continue;
		}
		const resolvable = getResolvableBy(program, declaration.entity);
		if (!resolvable) {
			continue;
		}
		const candidates = candidateJoinFields(
			program,
			projectionModel,
			declaration.entity,
		);
		if (candidates.length !== 1) {
			continue;
		}
		const field = candidates[0];
		if (!hasExpectedArity(declaration.direction, field)) {
			continue;
		}
		if (!composesIntoDocument(program, field)) {
			continue;
		}
		resolved.push({
			entity: declaration.entity,
			direction: declaration.direction,
			joinKey: declaration.joinKey,
			field,
			// A lookup fetches the row the key names, so the discovery index has
			// nothing to say about it.
			...(declaration.direction === "inbound" && resolvable.index
				? { index: resolvable.index }
				: {}),
		});
	}
	return resolved;
}

function hasExpectedArity(
	direction: JoinDirection,
	field: ModelProperty,
): boolean {
	const isArray = unwrapArrayElement(field.type) !== undefined;
	return direction === "inbound" ? isArray : !isArray;
}

export function toJoinDependencyManifestEntry(
	dependency: ResolvedJoinDependency,
): JoinDependencyManifestEntry {
	return {
		entity: dependency.entity.name,
		direction: dependency.direction,
		joinKey: dependency.joinKey.name,
		field: dependency.field.name,
		...(dependency.index ? { index: dependency.index } : {}),
	};
}

export function toResolvableByManifestEntry(
	program: Program,
	entity: Model,
): ResolvableByManifestEntry | undefined {
	const resolvable = getResolvableBy(program, entity);
	if (!resolvable) {
		return undefined;
	}
	return {
		entity: entity.name,
		key: resolvable.key.name,
		...(resolvable.index ? { index: resolvable.index } : {}),
	};
}

/**
 * The read a join runs against: the `@restResolver` GET operation that returns
 * the entity and takes its declared key as a parameter. A `listX()` returning
 * the same model does not serve the join — nothing hands it the key.
 */
export function servesResolvableByRead(
	program: Program,
	operation: Operation,
	entity: Model,
	key: string,
): boolean {
	const [httpOperation] = getHttpOperation(program, operation);
	if (httpOperation.verb.toLowerCase() !== "get") {
		return false;
	}
	if (unwrapReadModel(operation.returnType) !== entity) {
		return false;
	}
	return httpOperation.parameters.parameters.some(
		(parameter) =>
			(parameter.type === "path" || parameter.type === "query") &&
			parameter.name === key,
	);
}

/**
 * The model a read operation returns, single or as an array.
 */
export function unwrapReadModel(returnType: Type): Model | undefined {
	if (returnType.kind !== "Model") {
		return undefined;
	}
	if (returnType.name === "Array") {
		const element = returnType.indexer?.value;
		return element?.kind === "Model" ? element : undefined;
	}
	return returnType;
}

export function validateJoinDeclarations(program: Program): void {
	const operations = collectOperations(program);
	for (const model of collectModels(program)) {
		validateResolvableBy(program, model, operations);
		validateDependencies(program, model);
	}
}

function validateResolvableBy(
	program: Program,
	model: Model,
	operations: Operation[],
): void {
	const resolvable = getResolvableBy(program, model);
	if (!resolvable) {
		return;
	}

	if (!ownsProperty(model, resolvable.key)) {
		reportDiagnostic(program, {
			code: "unknown-join-key",
			format: { key: resolvable.key.name, model: model.name },
			target: resolvable.key,
		});
		return;
	}

	const served = operations.some(
		(operation) =>
			isRestResolver(program, operation) &&
			servesResolvableByRead(program, operation, model, resolvable.key.name),
	);
	if (!served) {
		reportDiagnostic(program, {
			code: "join-read-operation-missing",
			format: { entity: model.name, key: resolvable.key.name },
			target: model,
		});
	}
}

function validateDependencies(program: Program, projectionModel: Model): void {
	const declarations = getJoinDependencies(program, projectionModel);
	if (declarations.length === 0) {
		return;
	}

	const sourceModel = getProjectionSourceModel(program, projectionModel);
	if (!sourceModel) {
		reportDiagnostic(program, {
			code: "join-requires-projection",
			format: { model: projectionModel.name },
			target: projectionModel,
		});
		return;
	}

	for (const declaration of declarations) {
		if (!isJoinDirection(declaration.direction)) {
			reportDiagnostic(program, {
				code: "invalid-join-direction",
				format: { direction: declaration.direction },
				target: projectionModel,
			});
			continue;
		}

		const resolvable = getResolvableBy(program, declaration.entity);
		if (!resolvable) {
			reportDiagnostic(program, {
				code: "undeclared-join-resolution",
				format: { entity: declaration.entity.name },
				target: declaration.entity,
			});
			continue;
		}

		if (declaration.direction === "inbound" && !resolvable.index) {
			reportDiagnostic(program, {
				code: "join-index-required",
				format: {
					entity: declaration.entity.name,
					key: resolvable.key.name,
					suggestedIndex: `by${capitalize(resolvable.key.name)}`,
				},
				target: declaration.entity,
			});
			continue;
		}

		const owner = expectedJoinKeyOwner(declaration, sourceModel);
		if (!ownsProperty(owner, declaration.joinKey)) {
			reportDiagnostic(program, {
				code: "unknown-join-key",
				format: { key: declaration.joinKey.name, model: owner.name },
				target: declaration.joinKey,
			});
			continue;
		}

		validateJoinField(
			program,
			projectionModel,
			declaration.entity,
			declaration.direction,
		);
	}
}

function validateJoinField(
	program: Program,
	projectionModel: Model,
	entity: Model,
	direction: JoinDirection,
): void {
	const candidates = candidateJoinFields(program, projectionModel, entity);
	const expectedType =
		direction === "inbound"
			? `${entity.name}[] (or an array of its search document)`
			: `${entity.name} (or its search document)`;

	if (candidates.length === 0) {
		reportDiagnostic(program, {
			code: "join-field-missing",
			format: {
				entity: entity.name,
				direction,
				projection: projectionModel.name,
				expectedType,
			},
			target: projectionModel,
		});
		return;
	}

	if (candidates.length > 1) {
		reportDiagnostic(program, {
			code: "join-field-ambiguous",
			format: {
				entity: entity.name,
				direction,
				projection: projectionModel.name,
				fields: candidates.map((x) => x.name).join(", "),
			},
			target: projectionModel,
		});
		return;
	}

	const field = candidates[0];
	if (!hasExpectedArity(direction, field)) {
		const isArray = unwrapArrayElement(field.type) !== undefined;
		reportDiagnostic(program, {
			code: "join-field-arity",
			format: {
				field: field.name,
				direction,
				actual: isArray ? "an array" : "a single value",
				expected: isArray ? "a single row" : "many rows",
			},
			target: field,
		});
		return;
	}

	if (!composesIntoDocument(program, field)) {
		reportDiagnostic(program, {
			code: "join-field-not-composed",
			format: { field: field.name, entity: entity.name },
			target: field,
		});
	}
}

function collectModels(program: Program): Model[] {
	const models: Model[] = [];
	const walk = (namespace: Namespace) => {
		models.push(...namespace.models.values());
		for (const child of namespace.namespaces.values()) {
			walk(child);
		}
	};
	walk(program.getGlobalNamespaceType());
	return models;
}

function collectOperations(program: Program): Operation[] {
	const operations: Operation[] = [];
	const walk = (namespace: Namespace) => {
		operations.push(...namespace.operations.values());
		for (const iface of namespace.interfaces.values()) {
			operations.push(...iface.operations.values());
		}
		for (const child of namespace.namespaces.values()) {
			walk(child);
		}
	};
	walk(program.getGlobalNamespaceType());
	return operations;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

export const __test = {
	capitalize,
	expectedJoinKeyOwner,
	hasExpectedArity,
};
