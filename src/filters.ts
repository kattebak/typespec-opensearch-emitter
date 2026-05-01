import type { FilterableKind } from "./decorators.js";
import type {
	ResolvedProjection,
	ResolvedProjectionField,
} from "./projection.js";

export interface FilterableEntry {
	field: ResolvedProjectionField;
	kind: FilterableKind;
	openSearchField: string;
	nestedPath?: string;
	/**
	 * GraphQL input field name on the SearchFilter input type.
	 *  - term: <field>
	 *  - term_negate: <field>Not
	 *  - exists: <field>Exists
	 *  - range: <field>Gte / <field>Lte / <field>Gt / <field>Lt (one entry per bound)
	 */
	inputFieldName: string;
	/**
	 * For range only: which bound this entry covers (`gte` | `lte` | `gt` | `lt`).
	 */
	rangeBound?: RangeBound;
}

export const RANGE_BOUNDS = ["gte", "lte", "gt", "lt"] as const;
export type RangeBound = (typeof RANGE_BOUNDS)[number];

const RANGE_BOUND_SUFFIX: Record<RangeBound, string> = {
	gte: "Gte",
	lte: "Lte",
	gt: "Gt",
	lt: "Lt",
};

export function collectFilterables(
	projection: ResolvedProjection,
): FilterableEntry[] {
	return collectFilterablesRecursive(projection, undefined);
}

function collectFilterablesRecursive(
	projection: ResolvedProjection,
	nestedPath: string | undefined,
): FilterableEntry[] {
	const entries: FilterableEntry[] = [];

	if (!projection.fields) {
		return entries;
	}

	for (const field of projection.fields) {
		if (field.filterables && field.filterables.length > 0) {
			entries.push(...filterableEntriesForField(field, nestedPath));
		}

		if (field.subProjection) {
			const childPath = field.nested
				? joinNestedPath(nestedPath, field.projectedName ?? field.name)
				: nestedPath;
			entries.push(
				...collectFilterablesRecursive(field.subProjection, childPath),
			);
		}
	}

	return entries;
}

function filterableEntriesForField(
	field: ResolvedProjectionField,
	nestedPath: string | undefined,
): FilterableEntry[] {
	const entries: FilterableEntry[] = [];
	const projectedName = field.projectedName ?? field.name;
	const fieldPart = needsKeywordSuffix(field)
		? `${projectedName}.keyword`
		: projectedName;
	const openSearchField = nestedPath ? `${nestedPath}.${fieldPart}` : fieldPart;

	for (const kind of field.filterables ?? []) {
		if (kind === "range") {
			// Single FILTER_SPEC entry per range field; the resolver expands
			// the four bound checks (Gte/Lte/Gt/Lt) at iteration time. Saves
			// ~3 entries per range-filterable field on wide projections
			// (issue #101 — keeps the inline FILTER_SPEC under the AppSync
			// 32 KB cap on the consumer's 8-sub-model shape). The SDL emitter
			// still renders the four bound input fields by expanding this
			// single entry — see renderSearchFilterField.
			entries.push({
				field,
				kind,
				openSearchField,
				nestedPath,
				inputFieldName: projectedName,
			});
			continue;
		}
		entries.push({
			field,
			kind,
			openSearchField,
			nestedPath,
			inputFieldName: filterInputFieldName(projectedName, kind),
		});
	}
	return entries;
}

function filterInputFieldName(
	projectedName: string,
	kind: Exclude<FilterableKind, "range">,
): string {
	switch (kind) {
		case "term":
			return projectedName;
		case "term_negate":
			return `${projectedName}Not`;
		case "terms":
			return `${projectedName}In`;
		case "exists":
			return `${projectedName}Exists`;
	}
}

function joinNestedPath(parent: string | undefined, segment: string): string {
	return parent ? `${parent}.${segment}` : segment;
}

/**
 * For term/term_negate/exists/range we want exact-match semantics. On a
 * non-keyword text string field that means using the `.keyword` sub-field
 * (parity with how aggregations resolve text-vs-keyword).
 */
function needsKeywordSuffix(field: ResolvedProjectionField): boolean {
	if (field.keyword) return false;
	// Non-searchable string fields are mapped directly as keyword (see
	// emit-mapping.ts), so there is no `.keyword` sub-field to address.
	if (!field.searchable) return false;
	if (field.subProjection) return false;
	return isStringLikeType(field.type);
}

function isStringLikeType(type: ResolvedProjectionField["type"]): boolean {
	if (type.kind === "String") return true;
	if (type.kind === "Scalar") {
		let current: typeof type | undefined = type;
		while (current && current.kind === "Scalar") {
			if (current.name === "string") return true;
			if (current.name === "plainDate" || current.name === "utcDateTime") {
				return false;
			}
			current = current.baseScalar;
		}
		return false;
	}
	if (type.kind === "Model" && type.name === "Array" && type.indexer?.value) {
		const elementType = type.indexer.value;
		if (elementType.kind === "String") return true;
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

export function hasFilterables(projection: ResolvedProjection): boolean {
	return collectFilterables(projection).length > 0;
}

export function searchFilterTypeName(projectionName: string): string {
	const base = projectionName.replace(/SearchDoc$/, "");
	return `${base}SearchFilter`;
}

/**
 * Hierarchical filter spec mirroring the SDL shape. The resolver embeds this
 * as a JS literal at the top of the generated module and walks it at request
 * time to translate filter args into a `bool` OpenSearch query.
 */
export interface FilterSpecNode {
	/** Local input field name on the parent SearchFilter input. */
	inputName: string;
	/**
	 * `nested_exists` is an emit-time kind used when `@filterable("exists")` is
	 * applied to a `@nested` array field — the resolver translates it as
	 * `nested + match_all` (true) or `must_not nested + match_all` (false).
	 */
	kind: FilterableKind | "nested" | "nested_exists" | "object";
	/** OpenSearch field path (only set on leaf kinds). */
	field?: string;
	/** Source projection field (set on leaf kinds only; SDL renders use this for GraphQL type lookup). */
	sourceField?: ResolvedProjectionField;
	/** Nested doc path (set on `nested` and `nested_exists`). */
	path?: string;
	/** Children (set on `nested` and `object`). */
	children?: FilterSpecNode[];
	/** Range bound (only set on `kind === "range"`). */
	bound?: RangeBound;
	/** GraphQL input type for `nested` / `object` kinds (e.g. "TagSearchFilter"). */
	nestedTypeName?: string;
}

export interface SearchFilterShape {
	typeName: string;
	nodes: FilterSpecNode[];
	/** Sub-projection filter shapes that should also be emitted as input types. */
	nestedShapes: SearchFilterShape[];
}

export function buildSearchFilterShape(
	projection: ResolvedProjection,
): SearchFilterShape | undefined {
	if (!hasFilterables(projection)) {
		return undefined;
	}
	return buildShapeRecursive(projection, undefined);
}

function buildShapeRecursive(
	projection: ResolvedProjection,
	parentPath: string | undefined,
): SearchFilterShape {
	const nodes: FilterSpecNode[] = [];
	const nestedShapes: SearchFilterShape[] = [];

	if (projection.fields) {
		for (const field of projection.fields) {
			if (field.filterables && field.filterables.length > 0) {
				const entries = filterableEntriesForField(field, parentPath);
				for (const entry of entries) {
					// @filterable("exists") on a @nested array field becomes a
					// nested-existence check at emit time (see FilterSpecNode.kind).
					const isNestedPathExists =
						entry.kind === "exists" && field.nested && !!field.subProjection;
					nodes.push({
						inputName: entry.inputFieldName,
						kind: isNestedPathExists ? "nested_exists" : entry.kind,
						field: entry.openSearchField,
						sourceField: entry.field,
						bound: entry.rangeBound,
						path: isNestedPathExists
							? joinNestedPath(parentPath, field.projectedName ?? field.name)
							: undefined,
					});
				}
			}

			if (field.subProjection) {
				if (field.nested) {
					const nestedPath = joinNestedPath(
						parentPath,
						field.projectedName ?? field.name,
					);
					const subShape = buildShapeRecursive(field.subProjection, nestedPath);
					if (subShape.nodes.length > 0 || subShape.nestedShapes.length > 0) {
						const nestedTypeName = searchFilterTypeName(
							field.subProjection.projectionModel.name,
						);
						nodes.push({
							inputName: field.projectedName ?? field.name,
							kind: "nested",
							path: nestedPath,
							children: subShape.nodes,
							nestedTypeName,
						});
						nestedShapes.push({
							typeName: nestedTypeName,
							nodes: subShape.nodes,
							nestedShapes: subShape.nestedShapes,
						});
					}
				} else {
					// Non-`@nested` struct sub-projection: thread the dotted path
					// into children's OS field paths and emit as a separate input
					// type (issue #98). The parent's filter input references it as
					// `<fieldName>: <NestedType>SearchFilter`.
					const objectPath = joinNestedPath(
						parentPath,
						field.projectedName ?? field.name,
					);
					const subShape = buildShapeRecursive(field.subProjection, objectPath);
					if (subShape.nodes.length > 0 || subShape.nestedShapes.length > 0) {
						const subTypeName = searchFilterTypeName(
							field.subProjection.projectionModel.name,
						);
						nodes.push({
							inputName: field.projectedName ?? field.name,
							kind: "object",
							children: subShape.nodes,
							nestedTypeName: subTypeName,
						});
						nestedShapes.push({
							typeName: subTypeName,
							nodes: subShape.nodes,
							nestedShapes: subShape.nestedShapes,
						});
					}
				}
			}
		}
	}

	return {
		typeName: searchFilterTypeName(projection.projectionModel.name),
		nodes,
		nestedShapes,
	};
}

export const __test = {
	needsKeywordSuffix,
	isStringLikeType,
	filterInputFieldName,
};
