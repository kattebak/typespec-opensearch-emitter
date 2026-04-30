import type { AggregationKind } from "./decorators.js";
import type {
	ResolvedProjection,
	ResolvedProjectionField,
} from "./projection.js";

export interface AggregationEntry {
	field: ResolvedProjectionField;
	kind: AggregationKind;
	aggName: string;
	openSearchField: string;
	useTextType: boolean;
	nestedPath?: string;
}

/**
 * Inner agg name used when wrapping in `{ nested: { path }, aggs: { <innerName>: {...} } }`.
 * Kept stable so the response handler can unwrap symmetrically.
 */
export const NESTED_INNER_AGG_NAME = "inner";

export function collectAggregations(
	projection: ResolvedProjection,
): AggregationEntry[] {
	return collectAggregationsRecursive(projection, undefined);
}

function collectAggregationsRecursive(
	projection: ResolvedProjection,
	nestedPath: string | undefined,
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
			const openSearchField = nestedPath
				? `${nestedPath}.${fieldPart}`
				: fieldPart;

			for (const kind of field.aggregations) {
				entries.push({
					field,
					kind,
					aggName: aggregationFieldName(projectedName, kind, nestedPath),
					openSearchField,
					useTextType,
					nestedPath,
				});
			}
		}

		if (field.subProjection) {
			const childPath = field.nested
				? joinNestedPath(nestedPath, field.projectedName ?? field.name)
				: nestedPath;
			entries.push(
				...collectAggregationsRecursive(field.subProjection, childPath),
			);
		}
	}

	return entries;
}

function joinNestedPath(parent: string | undefined, segment: string): string {
	return parent ? `${parent}.${segment}` : segment;
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
	nestedPath?: string,
): string {
	const fieldPart = capitalize(singularize(fieldName));
	const prefix = nestedPath ? nestedPathPrefix(nestedPath) : "";
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
	}
}

function lowerFirst(name: string): string {
	if (name.length === 0) return name;
	return name[0].toLowerCase() + name.slice(1);
}

function nestedPathPrefix(nestedPath: string): string {
	return nestedPath
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
			if (current.name === "plainDate" || current.name === "utcDateTime") {
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
				if (current.name === "plainDate" || current.name === "utcDateTime") {
					return false;
				}
				current = current.baseScalar;
			}
		}
		return false;
	}
	return false;
}

export const __test = {
	aggregationFieldName,
	singularize,
	capitalize,
	isTextField,
};
