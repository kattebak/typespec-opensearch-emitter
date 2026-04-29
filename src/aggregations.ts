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
}

export function collectAggregations(
	projection: ResolvedProjection,
): AggregationEntry[] {
	const entries: AggregationEntry[] = [];

	for (const field of projection.fields) {
		if (!field.aggregations || field.aggregations.length === 0) {
			continue;
		}

		const projectedName = field.projectedName ?? field.name;
		const useTextType = isTextField(field);
		const openSearchField = useTextType
			? `${projectedName}.keyword`
			: projectedName;

		for (const kind of field.aggregations) {
			entries.push({
				field,
				kind,
				aggName: aggregationFieldName(projectedName, kind),
				openSearchField,
				useTextType,
			});
		}
	}

	return entries;
}

export function hasAggregations(projection: ResolvedProjection): boolean {
	return projection.fields.some(
		(field) => field.aggregations && field.aggregations.length > 0,
	);
}

export function aggregationsTypeName(projectionName: string): string {
	const base = projectionName.replace(/SearchDoc$/, "");
	return `${base}SearchAggregations`;
}

export function aggregationFieldName(
	fieldName: string,
	kind: AggregationKind,
): string {
	const singular = singularize(fieldName);
	const capital = capitalize(singular);
	switch (kind) {
		case "terms":
			return `by${capital}`;
		case "cardinality":
			return `unique${capital}Count`;
		case "missing":
			return `missing${capital}Count`;
	}
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
