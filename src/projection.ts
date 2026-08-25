import type { Model, ModelProperty, Program, Type } from "@typespec/compiler";
import {
	type AggregationDirective,
	type FilterableKind,
	getAggregatableDirectives,
	getAnalyzer,
	getBoost,
	getFilterableKinds,
	getIgnoreAbove,
	getIndexName,
	getIndexSettings,
	getJoinDependencies,
	getSearchAs,
	hasAggregatable,
	hasFilterable,
	isKeyword,
	isNested,
	isSearchable,
	isSearchInfer,
	isSearchSkip,
	isSortable,
} from "./decorators.js";

function isReachable(
	program: Program,
	prop: ModelProperty,
	inferOnModel: boolean,
): boolean {
	if (
		isSearchable(program, prop) ||
		hasFilterable(program, prop) ||
		hasAggregatable(program, prop)
	) {
		return true;
	}
	if (isSearchSkip(program, prop)) return false;
	// On a @searchInfer model, every source-model field is reachable.
	if (inferOnModel) return true;
	// Issue #102: even if the parent projection lacks @searchInfer, admit a
	// field whose type model carries @searchInfer — it'll auto-recurse into
	// a virtual sub-projection.
	const typeModel = unwrapStructModel(prop.type);
	return !!typeModel && isSearchInfer(program, typeModel);
}

import {
	candidateJoinFields,
	type ResolvedJoinDependency,
	resolveJoinDependencies,
	unwrapArrayElement,
} from "./joins.js";
import { reportDiagnostic } from "./lib.js";
import {
	getProjectionSourceModel,
	isSearchProjectionModel,
} from "./projection-source.js";
import { isDateScalarName } from "./utils.js";

export { getProjectionSourceModel, isSearchProjectionModel };

export interface ResolvedProjectionField {
	name: string;
	projectedName?: string;
	type: Type;
	optional: boolean;
	sourceProperty: ModelProperty;
	projectionProperty?: ModelProperty;
	searchable: boolean;
	keyword: boolean;
	nested: boolean;
	sortable: boolean;
	analyzer?: string;
	boost?: number;
	ignoreAbove?: number;
	aggregations?: AggregationDirective[];
	filterables?: FilterableKind[];
	subProjection?: ResolvedProjection;
}

/**
 * True when the property is the field a declared join fills (issue #194). It
 * is accounted for whether or not the join survives validation, so a broken
 * declaration reports its own diagnostic instead of also reading as a field
 * missing from the source model.
 */
function isJoinProvidedField(
	program: Program,
	projectionModel: Model,
	property: ModelProperty,
): boolean {
	return getJoinDependencies(program, projectionModel).some((declaration) =>
		candidateJoinFields(program, projectionModel, declaration.entity).includes(
			property,
		),
	);
}

export interface ResolvedProjection {
	projectionModel: Model;
	sourceModel: Model;
	/**
	 * Set only when the model carries `@indexName`. Absent means the projection
	 * is nested-only — no backing OpenSearch index exists for it (issue #157).
	 */
	indexName?: string;
	indexSettings?: Record<string, unknown>;
	fields: ResolvedProjectionField[];
	/**
	 * Cross-domain joins declared with `@dependsOn` (issue #194) that survived
	 * validation. Each one also contributes its bound field to `fields`, so the
	 * document type, mapping, SDL, filters and aggregations carry it.
	 */
	joins?: ResolvedJoinDependency[];
}

/**
 * A projection backed by a real OpenSearch index, and therefore eligible for
 * top-level emission: Query field, resolver, mapping, manifest entry.
 */
export type TopLevelProjection = ResolvedProjection & { indexName: string };

export function resolveProjectionModel(
	program: Program,
	projectionModel: Model,
): ResolvedProjection | undefined {
	const sourceModel = getProjectionSourceModel(program, projectionModel);
	if (!sourceModel) {
		return undefined;
	}

	const inferOnModel = isSearchInfer(program, projectionModel);
	// Composition path: a model already on it cannot be composed into itself.
	const visited: ReadonlySet<string> = new Set([projectionModel.name]);

	const fields: ResolvedProjectionField[] = [];
	for (const sourceProperty of sourceModel.properties.values()) {
		if (!isReachable(program, sourceProperty, inferOnModel)) {
			continue;
		}

		const projectionProperty = projectionModel.properties.get(
			sourceProperty.name,
		);
		const field = resolveProjectionField(
			program,
			sourceProperty,
			projectionProperty,
			inferOnModel,
		);

		// Check if the projection redeclares this field with a sub-projection type
		if (projectionProperty) {
			const subProj = resolveSubProjectionFromType(
				program,
				projectionProperty.type,
				visited,
			);
			if (subProj) {
				field.subProjection = subProj;
			}
		}

		// @searchInfer auto-recurses into struct fields (issue #98). When the
		// field's type resolves to a plain TypeSpec model (no explicit
		// SearchProjection<T>), build a virtual sub-projection so the parent
		// SearchFilter can reference <NestedType>SearchFilter.
		if (
			!field.subProjection &&
			!isSearchSkip(program, sourceProperty) &&
			shouldVirtualRecurse(program, field.type, inferOnModel)
		) {
			const virtual = buildVirtualSubProjection(program, field.type, visited);
			if (virtual) {
				field.subProjection = virtual;
			}
		}

		fields.push(field);
	}

	// Collect names already resolved from the source model
	const resolvedFieldNames = new Set(fields.map((f) => f.name));

	for (const projProp of projectionModel.properties.values()) {
		const sourceProp = sourceModel.properties.get(projProp.name);

		// Check if this property came from a spread of a different model
		const isSpreadFromOtherModel =
			projProp.sourceProperty &&
			projProp.sourceProperty.model &&
			projProp.sourceProperty.model !== sourceModel &&
			projProp.sourceProperty.model !== projectionModel;

		if (isSpreadFromOtherModel) {
			const spreadSourceProp = projProp.sourceProperty!;

			// Only include reachable fields from the spread source
			if (!isReachable(program, spreadSourceProp, inferOnModel)) {
				continue;
			}

			// Check for collision with already-resolved fields
			if (resolvedFieldNames.has(projProp.name)) {
				reportDiagnostic(program, {
					code: "spread-field-collision",
					format: { name: projProp.name },
					target: projProp,
				});
				continue;
			}

			// Resolve the spread field using the spread source property
			const field = resolveProjectionField(
				program,
				spreadSourceProp,
				projProp,
				inferOnModel,
			);

			// Check for sub-projection on the projection property
			const subProj = resolveSubProjectionFromType(
				program,
				projProp.type,
				visited,
			);
			if (subProj) {
				field.subProjection = subProj;
			}

			fields.push(field);
			resolvedFieldNames.add(projProp.name);
			continue;
		}

		if (!sourceProp || !isReachable(program, sourceProp, inferOnModel)) {
			// Allow sub-projection fields that reference a valid source field.
			// Naming one is all this asks — resolving it here would report its
			// diagnostics a second time.
			if (
				(!namesSubProjection(program, projProp.type) || !sourceProp) &&
				!isJoinProvidedField(program, projectionModel, projProp)
			) {
				reportDiagnostic(program, {
					code: "projection-field-not-on-source",
					format: { name: projProp.name, sourceModel: sourceModel.name },
					target: projProp,
				});
			}
		}
	}

	const joins = composeJoinFields(
		program,
		projectionModel,
		sourceModel,
		inferOnModel,
		visited,
		fields,
		resolvedFieldNames,
	);

	return {
		projectionModel,
		sourceModel,
		indexName: getIndexName(program, projectionModel),
		indexSettings: getIndexSettings(program, projectionModel),
		fields,
		joins,
	};
}

/**
 * Appends the fields a projection's `@dependsOn` declarations fill, dropping
 * any declaration that cannot take its place in the document: one composing a
 * model already on the composition path, and one whose field name is already
 * taken by the source model. Both are reported, and neither reaches `joins` —
 * a dependency the document does not carry would name a re-index trigger for a
 * field that is not there.
 */
function composeJoinFields(
	program: Program,
	projectionModel: Model,
	sourceModel: Model,
	inferOnModel: boolean,
	visited: ReadonlySet<string>,
	fields: ResolvedProjectionField[],
	resolvedFieldNames: Set<string>,
): ResolvedJoinDependency[] {
	const joins: ResolvedJoinDependency[] = [];
	for (const join of resolveJoinDependencies(program, projectionModel)) {
		const field = resolveJoinField(
			program,
			projectionModel,
			join,
			inferOnModel,
			visited,
		);
		if (!field) {
			continue;
		}
		if (resolvedFieldNames.has(field.name)) {
			reportDiagnostic(program, {
				code: "join-field-collision",
				format: { name: field.name, sourceModel: sourceModel.name },
				target: join.field,
			});
			continue;
		}
		resolvedFieldNames.add(field.name);
		fields.push(field);
		joins.push(join);
	}
	return joins;
}

/**
 * The document field a `@dependsOn` declaration fills (issue #195). No source
 * model owns the bound property, so it stands in for both axes, and the
 * declaration itself is what puts the field in the response shape — a join
 * states that the value belongs on the document.
 */
function resolveJoinField(
	program: Program,
	projectionModel: Model,
	join: ResolvedJoinDependency,
	inferOnModel: boolean,
	visited: ReadonlySet<string>,
): ResolvedProjectionField | undefined {
	const joined = unwrapArrayElement(join.field.type) ?? join.field.type;
	if (joined.kind === "Model" && visited.has(joined.name)) {
		reportDiagnostic(program, {
			code: "join-cycle",
			format: {
				field: join.field.name,
				entity: joined.name,
				projection: projectionModel.name,
			},
			target: join.field,
		});
		return undefined;
	}

	const field = resolveProjectionField(
		program,
		join.field,
		join.field,
		inferOnModel,
	);
	// A joined field composes whether or not the type is a SearchProjection<T>:
	// an entity typed directly still owes the document its filter and
	// aggregation contract, so it gets a sub-projection over what it declares
	// rather than a bare object the specs silently skip (issue #197).
	const subProjection =
		resolveSubProjectionFromType(program, field.type, visited) ??
		buildVirtualSubProjection(
			program,
			field.type,
			visited,
			shouldVirtualRecurse(program, field.type, inferOnModel),
		);

	return { ...field, searchable: true, subProjection };
}

function resolveProjectionField(
	program: Program,
	sourceProperty: ModelProperty,
	projectionProperty?: ModelProperty,
	inferOnModel = false,
): ResolvedProjectionField {
	const analyzer =
		(projectionProperty && getAnalyzer(program, projectionProperty)) ??
		getAnalyzer(program, sourceProperty);
	const boost =
		(projectionProperty && getBoost(program, projectionProperty)) ??
		getBoost(program, sourceProperty);
	const ignoreAbove =
		(projectionProperty && getIgnoreAbove(program, projectionProperty)) ??
		getIgnoreAbove(program, sourceProperty);

	const searchAs =
		(projectionProperty && getSearchAs(program, projectionProperty)) ??
		getSearchAs(program, sourceProperty);

	const explicitAggregations =
		(projectionProperty &&
			getAggregatableDirectives(program, projectionProperty)) ??
		getAggregatableDirectives(program, sourceProperty);

	const explicitFilterables =
		(projectionProperty && getFilterableKinds(program, projectionProperty)) ??
		getFilterableKinds(program, sourceProperty);

	const fieldType = projectionProperty?.type ?? sourceProperty.type;
	const keyword =
		(projectionProperty && isKeyword(program, projectionProperty)) ||
		isKeyword(program, sourceProperty);
	const nested =
		(projectionProperty && isNested(program, projectionProperty)) ||
		isNested(program, sourceProperty);

	// @searchInfer fills empty axes from the inference table. Explicit
	// decorators on either axis still win on that axis (the other axis
	// gets inferred independently). @searchSkip on the source property
	// suppresses inference entirely.
	const skipInference = isSearchSkip(program, sourceProperty);
	const inferred =
		inferOnModel && !skipInference
			? inferDirectives(fieldType, { keyword, nested })
			: undefined;

	const aggregations =
		explicitAggregations ?? inferred?.aggregations ?? undefined;
	const filterables = explicitFilterables ?? inferred?.filterables ?? undefined;

	const explicitSortable =
		(projectionProperty && isSortable(program, projectionProperty)) ||
		isSortable(program, sourceProperty);
	const inferredSortable =
		inferOnModel &&
		!skipInference &&
		isSortableType(fieldType, { keyword, nested });
	const sortable = explicitSortable || inferredSortable;

	return {
		name: sourceProperty.name,
		projectedName: searchAs,
		type: fieldType,
		optional: projectionProperty?.optional ?? sourceProperty.optional,
		sourceProperty,
		projectionProperty,
		searchable: isSearchable(program, sourceProperty),
		keyword,
		nested,
		sortable,
		analyzer,
		boost,
		ignoreAbove,
		aggregations,
		filterables,
	};
}

interface InferredDirectives {
	filterables?: FilterableKind[];
	aggregations?: AggregationDirective[];
}

/**
 * Type-driven defaults for fields on a `@searchInfer` model.
 *
 * Per issue #92's inference table:
 * - utcDateTime / offsetDateTime / plainDate → range filter, date_histogram(month) agg
 * - string + @keyword → term/exists filter, terms agg
 * - free-text string (no @keyword) → none, none
 * - numeric → range filter, sum/avg/min/max aggs
 * - boolean → term filter, no agg
 * - @nested array → exists (path-level) filter, no agg (sub-projection
 *   carries its own @searchInfer if desired)
 * - enum / scalar union → term/exists filter, terms agg
 * - bytes → none, none
 */
function inferDirectives(
	type: Type,
	flags: { keyword: boolean; nested: boolean },
): InferredDirectives {
	if (flags.nested) {
		return { filterables: ["exists"] };
	}

	if (type.kind === "Enum") {
		return {
			filterables: ["term", "terms", "exists"],
			aggregations: [{ kind: "terms" }],
		};
	}
	if (type.kind === "Union") {
		return {
			filterables: ["term", "terms", "exists"],
			aggregations: [{ kind: "terms" }],
		};
	}
	if (type.kind === "Boolean") {
		return { filterables: ["term", "terms"] };
	}
	if (type.kind === "Scalar") {
		const root = scalarRootName(type);
		if (root === "boolean") return { filterables: ["term", "terms"] };
		if (isDateScalarName(root)) {
			return {
				filterables: ["range"],
				aggregations: [
					{ kind: "date_histogram", options: { interval: "month" } },
				],
			};
		}
		if (isNumericRootName(root)) {
			return {
				filterables: ["range"],
				aggregations: [
					{ kind: "sum" },
					{ kind: "avg" },
					{ kind: "min" },
					{ kind: "max" },
				],
			};
		}
		if (root === "string") {
			if (flags.keyword) {
				return {
					filterables: ["term", "terms", "exists"],
					aggregations: [{ kind: "terms" }],
				};
			}
			// Free-text string — too ambiguous to infer.
			return {};
		}
		if (root === "bytes") return {};
	}
	if (type.kind === "String") {
		// Plain string literal type — same call as string. @keyword tells us
		// whether to enable term/terms; without it, leave alone.
		if (flags.keyword) {
			return {
				filterables: ["term", "exists"],
				aggregations: [{ kind: "terms" }],
			};
		}
		return {};
	}
	return {};
}

/**
 * @searchInfer treats a field as sortable when its type unambiguously orders:
 * keyword strings, numerics, dates, and booleans. Free-text strings and
 * @nested arrays are excluded — sorting them is either ill-defined
 * (text relevance is sort by score) or requires picking an element.
 */
function isSortableType(
	type: Type,
	flags: { keyword: boolean; nested: boolean },
): boolean {
	if (flags.nested) return false;
	if (type.kind === "Boolean") return true;
	if (type.kind === "Enum" || type.kind === "Union") return true;
	if (type.kind === "String") return flags.keyword;
	if (type.kind === "Scalar") {
		const root = scalarRootName(type);
		if (!root) return false;
		if (root === "boolean") return true;
		if (isDateScalarName(root)) return true;
		if (isNumericRootName(root)) return true;
		if (root === "string") return flags.keyword;
	}
	return false;
}

function scalarRootName(type: Type): string | undefined {
	let current: Type | undefined = type;
	while (current && current.kind === "Scalar") {
		if (!current.baseScalar) return current.name;
		current = current.baseScalar;
	}
	return undefined;
}

function isNumericRootName(name: string | undefined): boolean {
	if (!name) return false;
	return [
		"int8",
		"int16",
		"int32",
		"int64",
		"integer",
		"safeint",
		"uint8",
		"uint16",
		"uint32",
		"uint64",
		"float",
		"float32",
		"float64",
		"decimal",
		"numeric",
		"number",
	].includes(name);
}

/**
 * Build a virtual sub-projection for a struct or array-of-struct field on a
 * `@searchInfer` parent (issue #98). Recurses into the model's properties,
 * applying the inference table to each. The parent's SearchFilter exposes
 * `<fieldName>: <NestedType>SearchFilter`, and FILTER_SPEC dispatch threads
 * the dotted path (or nested wrapper if the field is `@nested`).
 */
/**
 * Per #102: a struct field should auto-recurse into a virtual sub-projection
 * when EITHER (a) the parent's projection model has @searchInfer, OR (b) the
 * field's underlying model carries @searchInfer itself. Recursion follows
 * model identity, not the emit root — so an `Address` model with @searchInfer
 * gets its nested filter input even when emitted inside a parent that lacks
 * @searchInfer (e.g. an explicit `LocationSearchDoc is SearchProjection<Location>`
 * embedded in a `@searchInfer`-decorated `CounterpartySearchDoc`).
 */
function shouldVirtualRecurse(
	program: Program,
	type: Type,
	parentInfersInferContext: boolean,
): boolean {
	if (parentInfersInferContext) return true;
	const model = unwrapStructModel(type);
	return !!model && isSearchInfer(program, model);
}

function unwrapStructModel(type: Type): Model | undefined {
	if (type.kind !== "Model") return undefined;
	if (
		type.name === "Array" &&
		type.indexer?.value?.kind === "Model" &&
		type.indexer.value.name !== "Array"
	) {
		return type.indexer.value;
	}
	if (type.name && type.name !== "Array" && type.properties) {
		return type;
	}
	return undefined;
}

/**
 * `infer` is off when the model states its own contribution field by field —
 * a joined entity typed directly (issue #197). Then only the properties a
 * decorator admits compose, and their explicit directives are all that carries,
 * matching what the document type and the mapping already emit for it.
 */
function buildVirtualSubProjection(
	program: Program,
	type: Type,
	visited: ReadonlySet<string>,
	infer = true,
): ResolvedProjection | undefined {
	let model: Model | undefined;
	if (type.kind === "Model") {
		if (
			type.name === "Array" &&
			type.indexer?.value?.kind === "Model" &&
			type.indexer.value.name !== "Array"
		) {
			model = type.indexer.value;
		} else if (type.name && type.name !== "Array" && type.properties) {
			model = type;
		}
	}
	if (!model || !model.properties || model.properties.size === 0) {
		return undefined;
	}
	// Skip explicit SearchProjection<T> instantiations — those are handled
	// by resolveSubProjectionFromType.
	if (getProjectionSourceModel(program, model)) {
		return undefined;
	}
	if (visited.has(model.name)) {
		return undefined;
	}
	const childVisited = new Set(visited);
	childVisited.add(model.name);

	const fields: ResolvedProjectionField[] = [];
	for (const prop of model.properties.values()) {
		if (isSearchSkip(program, prop)) continue;
		if (!infer && !isReachable(program, prop, false)) continue;
		const field = resolveProjectionField(program, prop, undefined, infer);
		if (
			!field.subProjection &&
			shouldVirtualRecurse(program, field.type, infer)
		) {
			const nestedVirtual = buildVirtualSubProjection(
				program,
				field.type,
				childVisited,
			);
			if (nestedVirtual) {
				field.subProjection = nestedVirtual;
			}
		}
		fields.push(field);
	}

	if (fields.length === 0) return undefined;

	return {
		projectionModel: model,
		sourceModel: model,
		indexName: getIndexName(program, model),
		fields,
	};
}

/**
 * Given a Type, check if it is (or is an array of) a SearchProjection model,
 * and if so resolve it recursively.
 */
function namesSubProjection(program: Program, type: Type): boolean {
	if (type.kind !== "Model") {
		return false;
	}
	const element = unwrapArrayElement(type);
	const model = element?.kind === "Model" ? element : type;
	return !!getProjectionSourceModel(program, model);
}

function resolveSubProjectionFromType(
	program: Program,
	type: Type,
	visited: ReadonlySet<string>,
): ResolvedProjection | undefined {
	// Handle direct model reference: TagSearchDoc
	if (type.kind === "Model") {
		// Handle Array<TagSearchDoc> — e.g. TagSearchDoc[]
		if (type.name === "Array" && type.indexer?.value?.kind === "Model") {
			return resolveSubProjectionModel(program, type.indexer.value, visited);
		}
		return resolveSubProjectionModel(program, type, visited);
	}
	return undefined;
}

function resolveSubProjectionModel(
	program: Program,
	model: Model,
	parentVisited: ReadonlySet<string>,
): ResolvedProjection | undefined {
	const sourceModel = getProjectionSourceModel(program, model);
	if (!sourceModel) {
		return undefined;
	}

	// Already being composed further up the path: stop rather than recurse
	// forever. A join into the cycle reports join-cycle and drops the field.
	if (parentVisited.has(model.name)) {
		return undefined;
	}
	const visited: ReadonlySet<string> = new Set(parentVisited).add(model.name);

	const inferOnModel = isSearchInfer(program, model);

	const fields: ResolvedProjectionField[] = [];
	for (const sourceProperty of sourceModel.properties.values()) {
		if (!isReachable(program, sourceProperty, inferOnModel)) {
			continue;
		}

		const projectionProperty = model.properties.get(sourceProperty.name);
		const field = resolveProjectionField(
			program,
			sourceProperty,
			projectionProperty,
			inferOnModel,
		);

		if (projectionProperty) {
			const subProj = resolveSubProjectionFromType(
				program,
				projectionProperty.type,
				visited,
			);
			if (subProj) {
				field.subProjection = subProj;
			}
		}

		// Type-identity recursion (issue #102): even when this projection
		// model lacks @searchInfer, recurse into a struct field whose own
		// model carries @searchInfer.
		if (
			!field.subProjection &&
			!isSearchSkip(program, sourceProperty) &&
			shouldVirtualRecurse(program, field.type, inferOnModel)
		) {
			const virtual = buildVirtualSubProjection(program, field.type, visited);
			if (virtual) {
				field.subProjection = virtual;
			}
		}

		fields.push(field);
	}

	const joins = composeJoinFields(
		program,
		model,
		sourceModel,
		inferOnModel,
		visited,
		fields,
		new Set(fields.map((x) => x.name)),
	);

	return {
		projectionModel: model,
		sourceModel,
		indexName: getIndexName(program, model),
		indexSettings: getIndexSettings(program, model),
		fields,
		joins,
	};
}

export const __test = {
	getProjectionSourceModel,
	isSearchProjectionModel,
	resolveProjectionField,
};
