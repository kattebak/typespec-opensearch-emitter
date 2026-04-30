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

export const AGGREGATION_KINDS = [
	"terms",
	"cardinality",
	"missing",
	"sum",
	"avg",
	"min",
	"max",
	"date_histogram",
	"range",
] as const;
export type AggregationKind = (typeof AGGREGATION_KINDS)[number];

export const DATE_HISTOGRAM_INTERVALS = [
	"year",
	"quarter",
	"month",
	"week",
	"day",
	"hour",
] as const;
export type DateHistogramInterval = (typeof DATE_HISTOGRAM_INTERVALS)[number];

export const SUB_AGG_KINDS = [
	"sum",
	"avg",
	"min",
	"max",
	"cardinality",
] as const;
export type SubAggKind = (typeof SUB_AGG_KINDS)[number];

export interface SubAggSpec {
	kind: SubAggKind;
	field: string;
}

export interface RangeBucketSpec {
	key?: string;
	from?: number;
	to?: number;
}

export interface DateHistogramOptions {
	interval: DateHistogramInterval;
}

export interface RangeOptions {
	ranges: RangeBucketSpec[];
}

export interface TermsOptions {
	sub?: Record<string, SubAggSpec>;
}

export type AggregationOptions =
	| DateHistogramOptions
	| RangeOptions
	| TermsOptions;

export interface AggregationDirective {
	kind: AggregationKind;
	options?: AggregationOptions;
}

function isAggregationKind(value: string): value is AggregationKind {
	return (AGGREGATION_KINDS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateHistogramInterval(
	value: unknown,
): value is DateHistogramInterval {
	return (
		typeof value === "string" &&
		(DATE_HISTOGRAM_INTERVALS as readonly string[]).includes(value)
	);
}

function isSubAggKind(value: unknown): value is SubAggKind {
	return (
		typeof value === "string" &&
		(SUB_AGG_KINDS as readonly string[]).includes(value)
	);
}

function validateOptions(
	context: DecoratorContext,
	target: ModelProperty,
	kind: AggregationKind,
	raw: unknown,
): AggregationOptions | undefined {
	if (kind === "date_histogram") {
		if (!isPlainObject(raw)) {
			reportDiagnostic(context.program, {
				code: "invalid-aggregation-options",
				format: { kind, reason: "expected an options object" },
				target,
			});
			return undefined;
		}
		const interval = raw.interval ?? "month";
		if (!isDateHistogramInterval(interval)) {
			reportDiagnostic(context.program, {
				code: "invalid-aggregation-options",
				format: {
					kind,
					reason: `interval must be one of ${DATE_HISTOGRAM_INTERVALS.join(", ")}`,
				},
				target,
			});
			return undefined;
		}
		return { interval };
	}
	if (kind === "range") {
		if (!isPlainObject(raw) || !Array.isArray(raw.ranges)) {
			reportDiagnostic(context.program, {
				code: "invalid-aggregation-options",
				format: {
					kind,
					reason: "expected { ranges: [{ from?, to?, key? }, ...] }",
				},
				target,
			});
			return undefined;
		}
		const ranges: RangeBucketSpec[] = [];
		for (const entry of raw.ranges) {
			if (!isPlainObject(entry)) {
				reportDiagnostic(context.program, {
					code: "invalid-aggregation-options",
					format: { kind, reason: "each range entry must be an object" },
					target,
				});
				return undefined;
			}
			const bucket: RangeBucketSpec = {};
			if (typeof entry.key === "string") bucket.key = entry.key;
			if (typeof entry.from === "number") bucket.from = entry.from;
			if (typeof entry.to === "number") bucket.to = entry.to;
			if (bucket.from === undefined && bucket.to === undefined) {
				reportDiagnostic(context.program, {
					code: "invalid-aggregation-options",
					format: {
						kind,
						reason: "each range entry must set at least one of from / to",
					},
					target,
				});
				return undefined;
			}
			ranges.push(bucket);
		}
		return { ranges };
	}
	if (kind === "terms") {
		if (!isPlainObject(raw)) {
			reportDiagnostic(context.program, {
				code: "invalid-aggregation-options",
				format: { kind, reason: "expected { sub: {...} }" },
				target,
			});
			return undefined;
		}
		if (raw.sub === undefined) {
			return {};
		}
		if (!isPlainObject(raw.sub)) {
			reportDiagnostic(context.program, {
				code: "invalid-aggregation-options",
				format: {
					kind,
					reason: "sub must map sub-agg names to { kind, field }",
				},
				target,
			});
			return undefined;
		}
		const sub: Record<string, SubAggSpec> = {};
		for (const [name, spec] of Object.entries(raw.sub)) {
			if (
				!isPlainObject(spec) ||
				!isSubAggKind(spec.kind) ||
				typeof spec.field !== "string"
			) {
				reportDiagnostic(context.program, {
					code: "invalid-aggregation-options",
					format: {
						kind,
						reason: `sub-agg "${name}" must be { kind: <metric>, field: <string> }`,
					},
					target,
				});
				return undefined;
			}
			sub[name] = { kind: spec.kind, field: spec.field };
		}
		return { sub };
	}
	reportDiagnostic(context.program, {
		code: "invalid-aggregation-options",
		format: { kind, reason: `${kind} does not accept options` },
		target,
	});
	return undefined;
}

export function $aggregatable(
	context: DecoratorContext,
	target: ModelProperty,
	...args: unknown[]
): void {
	if (args.length === 0) {
		reportDiagnostic(context.program, {
			code: "aggregatable-requires-kind",
			target,
		});
		return;
	}

	const directives: AggregationDirective[] = [];

	if (
		args.length === 2 &&
		typeof args[0] === "string" &&
		isPlainObject(args[1])
	) {
		const kind = args[0];
		if (!isAggregationKind(kind)) {
			reportDiagnostic(context.program, {
				code: "invalid-aggregation-kind",
				format: { kind },
				target: context.getArgumentTarget(0) ?? target,
			});
			return;
		}
		const options = validateOptions(context, target, kind, args[1]);
		if (options === undefined) return;
		directives.push({ kind, options });
	} else {
		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (typeof arg !== "string") {
				reportDiagnostic(context.program, {
					code: "invalid-aggregation-kind",
					format: { kind: String(arg) },
					target: context.getArgumentTarget(index) ?? target,
				});
				return;
			}
			if (!isAggregationKind(arg)) {
				reportDiagnostic(context.program, {
					code: "invalid-aggregation-kind",
					format: { kind: arg },
					target: context.getArgumentTarget(index) ?? target,
				});
				return;
			}
			if (arg === "date_histogram" || arg === "range") {
				reportDiagnostic(context.program, {
					code: "invalid-aggregation-options",
					format: { kind: arg, reason: `${arg} requires options` },
					target,
				});
				return;
			}
			if (!directives.some((d) => d.kind === arg && !d.options)) {
				directives.push({ kind: arg });
			}
		}
	}

	const existing =
		(context.program.stateMap(StateKeys.aggregatable).get(target) as
			| AggregationDirective[]
			| undefined) ?? [];
	const merged = [...existing];
	for (const next of directives) {
		const dup = merged.some(
			(d) =>
				d.kind === next.kind &&
				JSON.stringify(d.options ?? null) ===
					JSON.stringify(next.options ?? null),
		);
		if (!dup) merged.push(next);
	}
	context.program.stateMap(StateKeys.aggregatable).set(target, merged);
}

export function getAggregatableDirectives(
	program: Program,
	target: ModelProperty,
): AggregationDirective[] | undefined {
	const stored = program.stateMap(StateKeys.aggregatable).get(target);
	if (!stored) {
		return undefined;
	}
	return stored as AggregationDirective[];
}

export function getAggregatableKinds(
	program: Program,
	target: ModelProperty,
): AggregationKind[] | undefined {
	const directives = getAggregatableDirectives(program, target);
	if (!directives) return undefined;
	return directives.map((d) => d.kind);
}

export function hasAggregatable(
	program: Program,
	target: ModelProperty,
): boolean {
	return program.stateMap(StateKeys.aggregatable).has(target);
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

export function hasFilterable(
	program: Program,
	target: ModelProperty,
): boolean {
	return program.stateMap(StateKeys.filterable).has(target);
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
