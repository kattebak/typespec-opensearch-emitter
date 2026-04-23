import type {
	DecoratorContext,
	Model,
	ModelProperty,
	Program,
	Type,
} from "@typespec/compiler";
import { reportDiagnostic, StateKeys } from "./lib.js";

export const namespace = "Kattebak.OpenSearch";

/**
 * Default index name derivation:
 * CounterpartySearchDoc -> counterparty_search_doc
 */
export function deriveDefaultIndexName(modelName: string): string {
	return modelName
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[-\s]+/g, "_")
		.toLowerCase();
}

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
	if (!isStringType(target.type)) {
		reportDiagnostic(context.program, {
			code: "string-property-required",
			target,
			format: { decorator: "keyword" },
		});
		return;
	}

	context.program.stateSet(StateKeys.keyword).add(target);
}

export function isKeyword(program: Program, target: ModelProperty): boolean {
	return program.stateSet(StateKeys.keyword).has(target);
}

export function $nested(
	context: DecoratorContext,
	target: ModelProperty,
): void {
	if (!isArrayOfModelType(target.type)) {
		reportDiagnostic(context.program, {
			code: "nested-array-model-required",
			target,
		});
		return;
	}

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
	if (!isStringType(target.type)) {
		reportDiagnostic(context.program, {
			code: "string-property-required",
			target,
			format: { decorator: "analyzer" },
		});
		return;
	}

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
	const value = factor;
	if (!Number.isFinite(value) || value <= 0) {
		reportDiagnostic(context.program, {
			code: "positive-boost-required",
			target: context.getArgumentTarget(0) ?? target,
		});
		return;
	}

	context.program.stateMap(StateKeys.boost).set(target, value);
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

export function getIndexName(program: Program, target: Model): string {
	return (
		program.stateMap(StateKeys.indexName).get(target) ??
		deriveDefaultIndexName(target.name)
	);
}

function isStringType(type: Type): boolean {
	if (type.kind === "String") {
		return true;
	}

	if (type.kind !== "Scalar") {
		return false;
	}

	let current: Type = type;
	while (current.kind === "Scalar" && current.baseScalar) {
		current = current.baseScalar;
	}

	return current.kind === "Scalar" && current.name === "string";
}

function isArrayOfModelType(type: Type): boolean {
	if (type.kind !== "Model" || type.name !== "Array") {
		return false;
	}

	const elementType = type.indexer?.value;
	return elementType?.kind === "Model";
}

export const __test = {
	deriveDefaultIndexName,
	isArrayOfModelType,
	isStringType,
};
