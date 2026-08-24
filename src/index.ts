import type { Program } from "@typespec/compiler";
import { validateJoinDeclarations } from "./joins.js";

export {
	$aggregatable,
	$analyzer,
	$boost,
	$dependsOn,
	$filterable,
	$graphqlDirectives,
	$graphqlId,
	$ignoreAbove,
	$indexName,
	$indexSettings,
	$keyword,
	$nested,
	$resolvableBy,
	$restResolver,
	$searchAs,
	$searchable,
	$searchInfer,
	$searchProjection,
	$searchSkip,
	$sortable,
	getAggregatableKinds,
	getAnalyzer,
	getBoost,
	getFilterableKinds,
	getGraphqlDirectives,
	getIgnoreAbove,
	getIndexName,
	getIndexSettings,
	getJoinDependencies,
	getResolvableBy,
	getSearchAs,
	isGraphqlId,
	isKeyword,
	isNested,
	isRestResolver,
	isSearchable,
	isSearchInfer,
	isSearchProjection,
	isSearchSkip,
	isSortable,
	namespace,
} from "./decorators.js";
export { $onEmit } from "./emitter.js";
export {
	JOIN_DIRECTIONS,
	type JoinDependencyDeclaration,
	type JoinDependencyManifestEntry,
	type JoinDirection,
	type ResolvableByDeclaration,
	type ResolvableByManifestEntry,
	type ResolvedJoinDependency,
} from "./joins.js";
export { $lib } from "./lib.js";

export function $onValidate(program: Program): void {
	validateJoinDeclarations(program);
}
