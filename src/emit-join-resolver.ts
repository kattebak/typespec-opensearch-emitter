import type { Model, Program } from "@typespec/compiler";
import {
	renderEntityInterface,
	renderPropertyType,
	toDocTypeFileName,
} from "./emit-doc-type.js";
import type { ResolvedJoinDependency } from "./joins.js";
import type { ResolvedProjection } from "./projection.js";
import { toKebabCase } from "./utils.js";

export interface EmittedJoinResolverFile {
	fileName: string;
	content: string;
}

export function toJoinResolverFileName(projectionModelName: string): string {
	return `${toKebabCase(projectionModelName)}-join-resolver.ts`;
}

export function toJoinResolverInterfaceName(
	projectionModelName: string,
): string {
	return `${projectionModelName}JoinResolver`;
}

/**
 * The join-resolver interface a projection's `@dependsOn` declarations imply
 * (issue #194): one method per declaration, named for its direction, taking
 * the join key and returning the joined shape. Both joins are left joins, so a
 * `lookup` may resolve to nothing and a discovery may resolve to no rows.
 * `undefined` when the projection declares no joins.
 */
export function emitJoinResolver(
	program: Program,
	projection: ResolvedProjection,
	allProjections: ResolvedProjection[],
): EmittedJoinResolverFile | undefined {
	const joins = projection.joins ?? [];
	if (joins.length === 0) {
		return undefined;
	}

	const documentTypeByEntity = new Map<Model, string>();
	for (const candidate of allProjections) {
		if (!documentTypeByEntity.has(candidate.sourceModel)) {
			documentTypeByEntity.set(
				candidate.sourceModel,
				candidate.projectionModel.name,
			);
		}
	}

	const imports = new Map<string, string>();
	const localInterfaces = new Map<string, string>();
	const usedMethodNames = new Set<string>();
	const methods: string[] = [];

	for (const join of joins) {
		const documentType = documentTypeByEntity.get(join.entity);
		if (documentType) {
			const file = toDocTypeFileName(documentType).replace(/\.ts$/, ".js");
			imports.set(
				documentType,
				`import type { ${documentType} } from "./${file}";`,
			);
		} else if (!localInterfaces.has(join.entity.name)) {
			localInterfaces.set(
				join.entity.name,
				renderEntityInterface(program, join.entity),
			);
		}

		const joinedType = documentType ?? join.entity.name;
		const methodName = uniqueMethodName(join, usedMethodNames);
		usedMethodNames.add(methodName);

		const argument = `${join.joinKey.name}: ${renderPropertyType(program, join.joinKey)}`;
		const returnType =
			join.direction === "lookup"
				? `Promise<${joinedType} | undefined>`
				: `Promise<${joinedType}[]>`;

		methods.push(`\t${methodName}(${argument}): ${returnType};`);
	}

	const parts: string[] = [];
	const importLines = [...imports.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, line]) => line);
	if (importLines.length > 0) {
		parts.push(importLines.join("\n"), "");
	}
	for (const [, declaration] of [...localInterfaces.entries()].sort(
		([a], [b]) => a.localeCompare(b),
	)) {
		parts.push(`${declaration}\n`);
	}
	parts.push(
		`export interface ${toJoinResolverInterfaceName(projection.projectionModel.name)} {\n${methods.join("\n")}\n}\n`,
	);

	return {
		fileName: toJoinResolverFileName(projection.projectionModel.name),
		content: parts.join("\n"),
	};
}

function uniqueMethodName(
	join: ResolvedJoinDependency,
	used: ReadonlySet<string>,
): string {
	const verb = join.direction === "lookup" ? "lookup" : "discover";
	const base = `${verb}${join.entity.name}`;
	if (!used.has(base)) {
		return base;
	}
	return `${base}By${capitalize(join.joinKey.name)}`;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

export const __test = {
	toJoinResolverFileName,
	toJoinResolverInterfaceName,
	uniqueMethodName,
};
