import { collectSubProjections, toDocTypeFileName } from "./emit-doc-type.js";
import type { ResolvedProjection } from "./projection.js";

export interface EmittedIndexFile {
	fileName: string;
	content: string;
}

export function emitIndex(projections: ResolvedProjection[]): EmittedIndexFile {
	const sorted = [...projections].sort((a, b) =>
		a.projectionModel.name.localeCompare(b.projectionModel.name),
	);

	// Collect all sub-projections that need type exports
	const topLevelNames = new Set(sorted.map((p) => p.projectionModel.name));
	const subProjections: ResolvedProjection[] = [];
	const subNames = new Set<string>();
	for (const projection of sorted) {
		for (const sp of collectSubProjections(projection)) {
			const name = sp.projectionModel.name;
			if (!topLevelNames.has(name) && !subNames.has(name)) {
				subNames.add(name);
				subProjections.push(sp);
			}
		}
	}
	subProjections.sort((a, b) =>
		a.projectionModel.name.localeCompare(b.projectionModel.name),
	);

	const lines: string[] = [];

	// Export sub-projection types first
	for (const sp of subProjections) {
		const docTypeFile = toDocTypeFileName(sp.projectionModel.name).replace(
			/\.ts$/,
			".js",
		);
		lines.push(
			`export type { ${sp.projectionModel.name} } from "./${docTypeFile}";`,
		);
	}

	for (const projection of sorted) {
		const docTypeFile = toDocTypeFileName(
			projection.projectionModel.name,
		).replace(/\.ts$/, ".js");
		lines.push(
			`export type { ${projection.projectionModel.name} } from "./${docTypeFile}";`,
		);
		lines.push(
			`export const ${toIndexConstantName(projection.projectionModel.name)} = "${projection.indexName}";`,
		);
	}

	return {
		fileName: "index.ts",
		content: `${lines.join("\n")}\n`,
	};
}

export function toIndexConstantName(projectionModelName: string): string {
	return `${toSnakeUpper(projectionModelName)}_INDEX_NAME`;
}

function toSnakeUpper(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[-\s]+/g, "_")
		.toUpperCase();
}

export const __test = {
	toIndexConstantName,
};
