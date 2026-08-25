import { NoTarget, type Program, type Type } from "@typespec/compiler";
import type { AggregationKind, AggregationOptions } from "./decorators.js";
import { reportDiagnostic } from "./lib.js";
import type {
	ResolvedProjection,
	ResolvedProjectionField,
} from "./projection.js";
import { isDateScalarName } from "./utils.js";

export interface AggregationEntry {
	field: ResolvedProjectionField;
	kind: AggregationKind;
	aggName: string;
	openSearchField: string;
	useTextType: boolean;
	nestedPath?: string;
	options?: AggregationOptions;
}

/**
 * Inner agg name used when wrapping in `{ nested: { path }, aggs: { <innerName>: {...} } }`.
 * Kept stable so the response handler can unwrap symmetrically.
 */
export const NESTED_INNER_AGG_NAME = "inner";

export function collectAggregations(
	projection: ResolvedProjection,
): AggregationEntry[] {
	return collectAggregationsRecursive(projection, undefined, undefined);
}

/**
 * `documentPath` is where the field sits in the document; `nestedPath` is the
 * `nested` wrapper the aggregation runs inside, which only a `@nested` field
 * opens. A plain object sub-projection deepens the first and leaves the second
 * alone, the way the filter shape already threads a dotted path (issue #98).
 */
function collectAggregationsRecursive(
	projection: ResolvedProjection,
	nestedPath: string | undefined,
	documentPath: string | undefined,
): AggregationEntry[] {
	const entries: AggregationEntry[] = [];

	if (!projection.fields) {
		return entries;
	}

	for (const field of projection.fields) {
		if (field.aggregations && field.aggregations.length > 0) {
			const projectedName = field.projectedName ?? field.name;
			const useTextType = isTextField(field);
			const fieldPart = useTextType
				? `${projectedName}.keyword`
				: projectedName;
			const openSearchField = documentPath
				? `${documentPath}.${fieldPart}`
				: fieldPart;

			for (const directive of field.aggregations) {
				entries.push({
					field,
					kind: directive.kind,
					aggName: aggregationFieldName(
						projectedName,
						directive.kind,
						documentPath,
						isArrayType(field.type),
					),
					openSearchField,
					useTextType,
					nestedPath,
					options: directive.options,
				});
			}
		}

		if (field.subProjection) {
			const childPath = joinNestedPath(
				documentPath,
				field.projectedName ?? field.name,
			);
			entries.push(
				...collectAggregationsRecursive(
					field.subProjection,
					field.nested ? childPath : nestedPath,
					childPath,
				),
			);
		}
	}

	return entries;
}

function joinNestedPath(parent: string | undefined, segment: string): string {
	return parent ? `${parent}.${segment}` : segment;
}

/**
 * Two fields can derive the same aggregation name — `addressCountry` and a
 * nested `address.country` both reach `byAddressCountry`, and singularizing a
 * path segment widens the overlap. Assembly keeps the first and drops the
 * rest, so the second aggregation would silently never run: say so instead.
 */
export function reportAggregationNameCollisions(
	program: Program,
	aggregations: readonly AggregationEntry[],
): void {
	const claimed = new Map<string, AggregationEntry>();
	const reported = new Set<string>();

	for (const entry of aggregations) {
		const prior = claimed.get(entry.aggName);
		if (!prior) {
			claimed.set(entry.aggName, entry);
			continue;
		}
		if (
			prior.kind === entry.kind &&
			prior.openSearchField === entry.openSearchField &&
			prior.nestedPath === entry.nestedPath
		) {
			continue;
		}
		if (reported.has(entry.aggName)) {
			continue;
		}
		reported.add(entry.aggName);
		reportDiagnostic(program, {
			code: "aggregation-name-collision",
			format: {
				aggName: entry.aggName,
				first: prior.openSearchField,
				second: entry.openSearchField,
			},
			target:
				entry.field.projectionProperty ??
				entry.field.sourceProperty ??
				NoTarget,
		});
	}
}

export function hasAggregations(projection: ResolvedProjection): boolean {
	return collectAggregations(projection).length > 0;
}

export function aggregationsTypeName(projectionName: string): string {
	const base = projectionName.replace(/SearchDoc$/, "");
	return `${base}SearchAggregations`;
}

export function aggregationFieldName(
	fieldName: string,
	kind: AggregationKind,
	documentPath?: string,
	fieldIsArray = false,
): string {
	// Only collapse a trailing "s" when the source field is itself an array
	// (tags: Tag[] -> byTag). Singular fields whose name ends in "s"
	// (status, process, address) keep their name verbatim (byStatus,
	// byProcess, byAddress).
	const fieldPart = capitalize(
		fieldIsArray ? singularize(fieldName) : fieldName,
	);
	const prefix = documentPath ? documentPathPrefix(documentPath) : "";
	const capital = `${prefix}${fieldPart}`;
	const camel = lowerFirst(capital);
	switch (kind) {
		case "terms":
			return `by${capital}`;
		case "cardinality":
			return `unique${capital}Count`;
		case "missing":
			return `missing${capital}Count`;
		case "sum":
			return `${camel}Sum`;
		case "avg":
			return `${camel}Avg`;
		case "min":
			return `${camel}Min`;
		case "max":
			return `${camel}Max`;
		case "date_histogram":
			return `by${capital}OverTime`;
		case "range":
			return `by${capital}Range`;
	}
}

function lowerFirst(name: string): string {
	if (name.length === 0) return name;
	return name[0].toLowerCase() + name.slice(1);
}

function documentPathPrefix(documentPath: string): string {
	return documentPath
		.split(".")
		.map((segment) => capitalize(singularize(segment)))
		.join("");
}

function singularize(name: string): string {
	if (name.endsWith("ies") && name.length > 3) {
		return `${name.slice(0, -3)}y`;
	}
	if (name.endsWith("ses") || name.endsWith("xes") || name.endsWith("zes")) {
		return name.slice(0, -2);
	}
	if (name.endsWith("s") && !name.endsWith("ss") && name.length > 1) {
		return name.slice(0, -1);
	}
	return name;
}

function capitalize(name: string): string {
	if (name.length === 0) return name;
	return name[0].toUpperCase() + name.slice(1);
}

function isTextField(field: ResolvedProjectionField): boolean {
	if (field.keyword) {
		return false;
	}
	// Non-searchable string fields are mapped directly as keyword (see
	// emit-mapping.ts), so there is no `.keyword` sub-field to address.
	if (!field.searchable) {
		return false;
	}
	if (field.subProjection) {
		return false;
	}
	return isStringLikeType(field.type);
}

function isStringLikeType(type: ResolvedProjectionField["type"]): boolean {
	if (type.kind === "String") {
		return true;
	}
	if (type.kind === "Scalar") {
		let current: typeof type | undefined = type;
		while (current && current.kind === "Scalar") {
			if (current.name === "string") {
				return true;
			}
			if (isDateScalarName(current.name)) {
				return false;
			}
			current = current.baseScalar;
		}
		return false;
	}
	if (type.kind === "Model" && type.name === "Array" && type.indexer?.value) {
		const elementType = type.indexer.value;
		if (elementType.kind === "String") {
			return true;
		}
		if (elementType.kind === "Scalar") {
			let current: typeof elementType | undefined = elementType;
			while (current && current.kind === "Scalar") {
				if (current.name === "string") return true;
				if (isDateScalarName(current.name)) {
					return false;
				}
				current = current.baseScalar;
			}
		}
		return false;
	}
	return false;
}

function isArrayType(type: Type): boolean {
	return (
		type.kind === "Model" &&
		type.name === "Array" &&
		type.indexer?.value !== undefined
	);
}

export const __test = {
	aggregationFieldName,
	singularize,
	capitalize,
	isTextField,
	isArrayType,
};
