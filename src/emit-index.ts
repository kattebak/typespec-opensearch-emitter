import { toDocTypeFileName } from "./emit-doc-type.js";
import type { ResolvedProjection } from "./projection.js";

export interface EmittedIndexFile {
	fileName: string;
	content: string;
}

export function emitIndex(projections: ResolvedProjection[]): EmittedIndexFile {
	const sorted = [...projections].sort((a, b) =>
		a.projectionModel.name.localeCompare(b.projectionModel.name),
	);

	const lines: string[] = [];
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
