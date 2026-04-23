import type {
	DecoratorContext,
	Model,
	ModelProperty,
	Program,
} from "@typespec/compiler";
import { StateKeys } from "./lib.js";

export const namespace = "Kattebak.OpenSearch";

export function $searchable(
	context: DecoratorContext,
	target: ModelProperty,
): void {
	context.program.stateSet(StateKeys.searchable).add(target);
}

export function isSearchable(program: Program, target: ModelProperty): boolean {
	return program.stateSet(StateKeys.searchable).has(target);
}

export function $keyword(
	context: DecoratorContext,
	target: ModelProperty,
): void {
	context.program.stateSet(StateKeys.keyword).add(target);
}

export function isKeyword(program: Program, target: ModelProperty): boolean {
	return program.stateSet(StateKeys.keyword).has(target);
}

export function $nested(
	context: DecoratorContext,
	target: ModelProperty,
): void {
	context.program.stateSet(StateKeys.nested).add(target);
}

export function isNested(program: Program, target: ModelProperty): boolean {
	return program.stateSet(StateKeys.nested).has(target);
}

export function $analyzer(
	context: DecoratorContext,
	target: ModelProperty,
	name: string,
): void {
	context.program.stateMap(StateKeys.analyzer).set(target, name);
}

export function getAnalyzer(
	program: Program,
	target: ModelProperty,
): string | undefined {
	return program.stateMap(StateKeys.analyzer).get(target);
}

export function $boost(
	context: DecoratorContext,
	target: ModelProperty,
	factor: number,
): void {
	context.program.stateMap(StateKeys.boost).set(target, factor);
}

export function getBoost(
	program: Program,
	target: ModelProperty,
): number | undefined {
	return program.stateMap(StateKeys.boost).get(target);
}

export function $indexName(
	context: DecoratorContext,
	target: Model,
	name: string,
): void {
	context.program.stateMap(StateKeys.indexName).set(target, name);
}

export function getIndexName(
	program: Program,
	target: Model,
): string | undefined {
	return program.stateMap(StateKeys.indexName).get(target);
}
