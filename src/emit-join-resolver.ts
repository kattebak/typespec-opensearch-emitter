import type { Model, Program } from "@typespec/compiler";
import {
	renderEntityInterface,
	renderPropertyType,
	toDocTypeFileName,
} from "./emit-doc-type.js";
import { unwrapArrayElement } from "./joins.js";
import type { ResolvedProjection } from "./projection.js";
import { isSearchProjectionModel } from "./projection-source.js";
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
 * (issue #194): one method per declaration, named for the document field it
 * fills, taking the join key and returning that field's declared type. Both
 * joins are left joins, so a `lookup` may resolve to nothing and a discovery
 * to no rows. `undefined` when the projection declares no joins.
 */
export function emitJoinResolver(
	program: Program,
	projection: ResolvedProjection,
): EmittedJoinResolverFile | undefined {
	const joins = projection.joins ?? [];
	if (joins.length === 0) {
		return undefined;
	}

	const imports = new Map<string, string>();
	const localInterfaces = new Map<string, string>();
	const methodNames = new Set<string>();
	const methods: string[] = [];

	for (const join of joins) {
		const joined = unwrapArrayElement(join.field.type) ?? join.field.type;
		if (joined.kind !== "Model") {
			throw new Error(
				`Join field "${join.field.name}" on ${projection.projectionModel.name} does not resolve to a model.`,
			);
		}

		if (isSearchProjectionModel(program, joined)) {
			const file = toDocTypeFileName(joined.name).replace(/\.ts$/, ".js");
			imports.set(
				joined.name,
				`import type { ${joined.name} } from "./${file}";`,
			);
		} else if (!localInterfaces.has(joined.name)) {
			localInterfaces.set(joined.name, renderEntityInterface(program, joined));
		}

		const methodName = toMethodName(join.direction, join.field.name);
		if (methodNames.has(methodName)) {
			throw new Error(
				`Join-resolver method "${methodName}" is declared twice on ${projection.projectionModel.name}.`,
			);
		}
		methodNames.add(methodName);

		const argument = `${join.joinKey.name}: ${renderPropertyType(program, join.joinKey)}`;
		const returnType =
			join.direction === "lookup"
				? `Promise<${joined.name} | undefined>`
				: `Promise<${joined.name}[]>`;

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

/**
 * Named for the field it fills, so two joins over the same entity stay apart
 * without a disambiguation rule — a model cannot declare a property twice.
 */
function toMethodName(direction: string, fieldName: string): string {
	const verb = direction === "lookup" ? "lookup" : "discover";
	return `${verb}${fieldName.charAt(0).toUpperCase()}${fieldName.slice(1)}`;
}

export const __test = {
	toJoinResolverFileName,
	toJoinResolverInterfaceName,
	toMethodName,
};
