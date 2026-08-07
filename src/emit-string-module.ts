import { toKebabCase } from "./utils.js";

export interface EmittedStringModule {
	/** Path inside the package, e.g. `resolvers/pet-search-doc-resolver.ts`. */
	fileName: string;
	/** Extensionless package subpath, e.g. `resolvers/pet-search-doc-resolver`. */
	moduleSpecifier: string;
	content: string;
}

export const RESOLVER_MODULE_DIR = "resolvers";
export const SCHEMA_MODULE_DIR = "schema";

export function resolverModuleSpecifier(resolverFileName: string): string {
	return `${RESOLVER_MODULE_DIR}/${moduleBaseName(resolverFileName)}`;
}

export function sdlModuleSpecifier(sdlFileName: string): string {
	return `${SCHEMA_MODULE_DIR}/${moduleBaseName(sdlFileName)}`;
}

export function emitResolverStringModule(
	resolverFileName: string,
	source: string,
): EmittedStringModule {
	const moduleSpecifier = resolverModuleSpecifier(resolverFileName);
	return {
		fileName: `${moduleSpecifier}.ts`,
		moduleSpecifier,
		content: `export const code = ${toStringLiteral(source)};\n`,
	};
}

export function emitSdlStringModule(
	sdlFileName: string,
	source: string,
): EmittedStringModule {
	const moduleSpecifier = sdlModuleSpecifier(sdlFileName);
	return {
		fileName: `${moduleSpecifier}.ts`,
		moduleSpecifier,
		content: `export const sdl = ${toStringLiteral(source)};\n`,
	};
}

/**
 * Every string module the package ships, followed by the two barrels over
 * them. Empty when nothing was emitted, so a spec with no projections keeps
 * its previous output.
 */
export function collectStringModules(
	resolvers: EmittedStringModule[],
	pipelineFunctions: EmittedStringModule[],
	sdlModules: EmittedStringModule[],
): EmittedStringModule[] {
	const modules = [
		...dedupe(resolvers),
		...dedupe(pipelineFunctions),
		...dedupe(sdlModules),
	];
	if (modules.length === 0) return [];

	return [
		...modules,
		emitResolverBarrel(dedupe(resolvers), dedupe(pipelineFunctions)),
		emitSdlBarrel(dedupe(sdlModules)),
	];
}

function dedupe(modules: EmittedStringModule[]): EmittedStringModule[] {
	const bySpecifier = new Map<string, EmittedStringModule>();
	for (const module of modules) {
		bySpecifier.set(module.moduleSpecifier, module);
	}
	return [...bySpecifier.values()];
}

/**
 * Barrels for the string modules. The consumer of the manifest is
 * data-driven — it iterates `resolvers[]` and looks each entry's code up by
 * the specifier the manifest carries — so a per-resolver static import would
 * mean one hand-maintained import line per emitted file. The barrel is that
 * lookup: one static import per package, keyed by the same specifier the
 * manifest names, exhaustive over every file emission wrote.
 */
export function emitResolverBarrel(
	resolvers: EmittedStringModule[],
	pipelineFunctions: EmittedStringModule[],
): EmittedStringModule {
	const used = new Set(["resolverCode", "pipelineFunctionCode", "code"]);
	const resolverEntries = toBarrelEntries(resolvers, used);
	const functionEntries = toBarrelEntries(pipelineFunctions, used);

	return {
		fileName: `${RESOLVER_MODULE_DIR}/index.ts`,
		moduleSpecifier: RESOLVER_MODULE_DIR,
		content: [
			renderImports(
				[...resolverEntries, ...functionEntries],
				"code",
				RESOLVER_MODULE_DIR,
			),
			renderRecord("resolverCode", resolverEntries),
			renderRecord("pipelineFunctionCode", functionEntries),
		].join(""),
	};
}

export function emitSdlBarrel(
	sdlModules: EmittedStringModule[],
): EmittedStringModule {
	const entries = toBarrelEntries(sdlModules, new Set(["sdl"]));

	return {
		fileName: `${SCHEMA_MODULE_DIR}/index.ts`,
		moduleSpecifier: SCHEMA_MODULE_DIR,
		content: [
			renderImports(entries, "sdl", SCHEMA_MODULE_DIR),
			renderRecord("sdl", entries),
		].join(""),
	};
}

interface BarrelEntry {
	moduleSpecifier: string;
	binding: string;
}

function toBarrelEntries(
	modules: EmittedStringModule[],
	used: Set<string>,
): BarrelEntry[] {
	return [...modules]
		.sort((a, b) => a.moduleSpecifier.localeCompare(b.moduleSpecifier))
		.map((module) => ({
			moduleSpecifier: module.moduleSpecifier,
			binding: uniqueBinding(module.moduleSpecifier, used),
		}));
}

function renderImports(
	entries: BarrelEntry[],
	exportName: string,
	dir: string,
): string {
	if (entries.length === 0) return "";
	const lines = entries
		.map(
			(entry) =>
				`import { ${exportName} as ${entry.binding} } from "./${entry.moduleSpecifier.slice(dir.length + 1)}.js";`,
		)
		.sort((a, b) => a.localeCompare(b));
	return `${lines.join("\n")}\n\n`;
}

function renderRecord(name: string, entries: BarrelEntry[]): string {
	if (entries.length === 0) {
		return `export const ${name}: Record<string, string> = {};\n`;
	}
	const lines = entries.map(
		(entry) => `\t${JSON.stringify(entry.moduleSpecifier)}: ${entry.binding},`,
	);
	return `export const ${name}: Record<string, string> = {\n${lines.join("\n")}\n};\n`;
}

function uniqueBinding(moduleSpecifier: string, used: Set<string>): string {
	const base = toBinding(
		moduleSpecifier.slice(moduleSpecifier.indexOf("/") + 1),
	);
	let binding = base;
	let suffix = 2;
	while (used.has(binding)) {
		binding = `${base}${suffix}`;
		suffix += 1;
	}
	used.add(binding);
	return binding;
}

function toBinding(baseName: string): string {
	const camel = baseName.replace(/[^a-zA-Z0-9]+(.)?/g, (_, next: string) =>
		next ? next.toUpperCase() : "",
	);
	return /^[a-zA-Z_$]/.test(camel) ? camel : `_${camel}`;
}

function moduleBaseName(fileName: string): string {
	return toKebabCase(fileName.replace(/\.[^.]+$/, "").replace(/\./g, "-"));
}

/**
 * `JSON.stringify` covers every escape a JS/GraphQL body can carry — quotes,
 * backslashes, control characters — and `${` is inert in a double-quoted
 * literal. U+2028/U+2029 are legal in an ES2019 string literal but not in
 * every parser that reads the generated package, so they are escaped too.
 */
function toStringLiteral(source: string): string {
	return JSON.stringify(source).replace(
		/[\u2028\u2029]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16)}`,
	);
}

export const __test = {
	moduleBaseName,
	toStringLiteral,
	toBinding,
};
