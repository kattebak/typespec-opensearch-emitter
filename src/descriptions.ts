import { getDoc, type Program, type Type } from "@typespec/compiler";

/**
 * SDL descriptions (issue #212). The text is whatever `@doc` or a doc comment
 * put on the TypeSpec type — the emitter writes none of its own, so a type,
 * field or argument without `@doc` carries no description.
 */
export function resolveDescription(
	program: Program,
	...targets: (Type | undefined)[]
): string | undefined {
	for (const target of targets) {
		if (!target) continue;
		const doc = getDoc(program, target);
		if (doc) return doc;
	}
	return undefined;
}

/**
 * Renders a description as a block string at `indent`. Always multi-line: text
 * that starts or ends with a quote, or ends with a backslash, is only safe on
 * a line of its own, and GraphQL strips the common indentation back off when
 * it parses the block, so the text a consumer reads is the text `@doc` set. A
 * literal `"""` inside the text is escaped.
 */
export function renderDescription(
	doc: string | undefined,
	indent = "",
): string | undefined {
	if (!doc) return undefined;
	const lines = doc.replace(/"""/g, '\\"""').split(/\r\n|[\n\r]/);
	return [
		`${indent}"""`,
		...lines.map((line) => (line === "" ? line : `${indent}${line}`)),
		`${indent}"""`,
	].join("\n");
}

/** Prefixes `block` with its rendered description, when it has one. */
export function withDescription(
	description: string | undefined,
	block: string,
): string {
	if (description === undefined) return block;
	return `${description}\n${block}`;
}
