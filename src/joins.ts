import type {
	Model,
	ModelProperty,
	Namespace,
	Program,
} from "@typespec/compiler";
import { getJoinDependencies, getResolvableBy } from "./decorators.js";
import { reportDiagnostic } from "./lib.js";
import { getProjectionSourceModel } from "./projection.js";

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
		resolved.push({
			entity: declaration.entity,
			direction: declaration.direction,
			joinKey: declaration.joinKey,
			...(resolvable.index ? { index: resolvable.index } : {}),
		});
	}
	return resolved;
}

export function toJoinDependencyManifestEntry(
	dependency: ResolvedJoinDependency,
): JoinDependencyManifestEntry {
	return {
		entity: dependency.entity.name,
		direction: dependency.direction,
		joinKey: dependency.joinKey.name,
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

export function validateJoinDeclarations(program: Program): void {
	for (const model of collectModels(program)) {
		validateResolvableBy(program, model);
		validateDependencies(program, model);
	}
}

function validateResolvableBy(program: Program, model: Model): void {
	const resolvable = getResolvableBy(program, model);
	if (!resolvable) {
		return;
	}
	if (resolvable.key.model !== model) {
		reportDiagnostic(program, {
			code: "unknown-join-key",
			format: { key: resolvable.key.name, model: model.name },
			target: resolvable.key,
		});
	}
}

function validateDependencies(program: Program, projectionModel: Model): void {
	const declarations = getJoinDependencies(program, projectionModel);
	if (declarations.length === 0) {
		return;
	}
	const sourceModel = getProjectionSourceModel(program, projectionModel);

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

		if (!sourceModel) {
			continue;
		}
		const owner = expectedJoinKeyOwner(declaration, sourceModel);
		if (declaration.joinKey.model !== owner) {
			reportDiagnostic(program, {
				code: "unknown-join-key",
				format: { key: declaration.joinKey.name, model: owner.name },
				target: declaration.joinKey,
			});
		}
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

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

export const __test = {
	capitalize,
	expectedJoinKeyOwner,
};
