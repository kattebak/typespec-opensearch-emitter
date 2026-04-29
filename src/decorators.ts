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

export function $ignoreAbove(
	context: DecoratorContext,
	target: ModelProperty,
	limit: number,
): void {
	const value = limit;
	if (!Number.isFinite(value) || value <= 0) {
		reportDiagnostic(context.program, {
			code: "positive-ignore-above-required",
			target: context.getArgumentTarget(0) ?? target,
		});
		return;
	}

	context.program.stateMap(StateKeys.ignoreAbove).set(target, value);
}

export function getIgnoreAbove(
	program: Program,
	target: ModelProperty,
): number | undefined {
	return program.stateMap(StateKeys.ignoreAbove).get(target);
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

export function $indexSettings(
	context: DecoratorContext,
	target: Model,
	settings: string,
): void {
	try {
		JSON.parse(settings);
	} catch {
		reportDiagnostic(context.program, {
			code: "invalid-index-settings-json",
			target,
		});
		return;
	}

	context.program.stateMap(StateKeys.indexSettings).set(target, settings);
}

export function getIndexSettings(
	program: Program,
	target: Model,
): Record<string, unknown> | undefined {
	const raw = program.stateMap(StateKeys.indexSettings).get(target);
	return raw ? JSON.parse(raw) : undefined;
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

export const AGGREGATION_KINDS = ["terms", "cardinality", "missing"] as const;
export type AggregationKind = (typeof AGGREGATION_KINDS)[number];

function isAggregationKind(value: string): value is AggregationKind {
	return (AGGREGATION_KINDS as readonly string[]).includes(value);
}

export function $aggregatable(
	context: DecoratorContext,
	target: ModelProperty,
	...kinds: string[]
): void {
	if (kinds.length === 0) {
		reportDiagnostic(context.program, {
			code: "aggregatable-requires-kind",
			target,
		});
		return;
	}

	const validated: AggregationKind[] = [];
	for (let index = 0; index < kinds.length; index++) {
		const kind = kinds[index];
		if (!isAggregationKind(kind)) {
			reportDiagnostic(context.program, {
				code: "invalid-aggregation-kind",
				format: { kind },
				target: context.getArgumentTarget(index) ?? target,
			});
			return;
		}
		if (!validated.includes(kind)) {
			validated.push(kind);
		}
	}

	context.program.stateMap(StateKeys.aggregatable).set(target, validated);
}

export function getAggregatableKinds(
	program: Program,
	target: ModelProperty,
): AggregationKind[] | undefined {
	const stored = program.stateMap(StateKeys.aggregatable).get(target);
	if (!stored) {
		return undefined;
	}
	return stored as AggregationKind[];
}

export const FILTERABLE_KINDS = [
	"term",
	"term_negate",
	"exists",
	"range",
] as const;
export type FilterableKind = (typeof FILTERABLE_KINDS)[number];

function isFilterableKind(value: string): value is FilterableKind {
	return (FILTERABLE_KINDS as readonly string[]).includes(value);
}

export function $filterable(
	context: DecoratorContext,
	target: ModelProperty,
	...kinds: string[]
): void {
	if (kinds.length === 0) {
		reportDiagnostic(context.program, {
			code: "filterable-requires-kind",
			target,
		});
		return;
	}

	const validated: FilterableKind[] = [];
	for (let index = 0; index < kinds.length; index++) {
		const kind = kinds[index];
		if (!isFilterableKind(kind)) {
			reportDiagnostic(context.program, {
				code: "invalid-filterable-kind",
				format: { kind },
				target: context.getArgumentTarget(index) ?? target,
			});
			return;
		}
		if (!validated.includes(kind)) {
			validated.push(kind);
		}
	}

	context.program.stateMap(StateKeys.filterable).set(target, validated);
}

export function getFilterableKinds(
	program: Program,
	target: ModelProperty,
): FilterableKind[] | undefined {
	const stored = program.stateMap(StateKeys.filterable).get(target);
	if (!stored) {
		return undefined;
	}
	return stored as FilterableKind[];
}

export function $searchAs(
	context: DecoratorContext,
	target: ModelProperty,
	name: string,
): void {
	if (!name) {
		reportDiagnostic(context.program, {
			code: "non-empty-search-as-required",
			target: context.getArgumentTarget(0) ?? target,
		});
		return;
	}

	context.program.stateMap(StateKeys.searchAs).set(target, name);
}

export function getSearchAs(
	program: Program,
	target: ModelProperty,
): string | undefined {
	return program.stateMap(StateKeys.searchAs).get(target);
}

export const __test = {
	deriveDefaultIndexName,
	isArrayOfModelType,
	isStringType,
};
