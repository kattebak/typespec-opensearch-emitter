import { fileURLToPath } from "node:url";
import { resolvePath } from "@typespec/compiler";
import {
	createTestLibrary,
	type TypeSpecTestLibrary,
} from "@typespec/compiler/testing";

export const OpenSearchEmitterTestLibrary: TypeSpecTestLibrary =
	createTestLibrary({
		name: "@kattebak/typespec-opensearch-emitter",
		packageRoot: resolvePath(fileURLToPath(import.meta.url), "../../../"),
		typespecFileFolder: "tsp",
		jsFileFolder: "dist",
	});
