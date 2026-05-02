/**
 * Emit-time string-literal interning for APPSYNC_JS resolver code.
 *
 * Replaces the terser-based minify pass (issue #112) — terser's general-JS
 * optimizations produced output that passed APPSYNC_JS static lint AND the
 * `EvaluateCode` API but failed at request-evaluation time on `term` /
 * `range` clauses inside a nested path. Custom interning emits ONLY two
 * construct kinds: a `const _s = ["..."]` array declaration and `_s[N]`
 * indexed reads. Both are trivially APPSYNC_JS-safe by construction.
 *
 * Algorithm:
 *   1. Tokenize the source minimally — track whether we are inside a string,
 *      template literal, line comment, or block comment.
 *   2. Collect every double-quoted string literal that is NOT a property KEY
 *      (a property key is a `"foo"` immediately followed, after optional
 *      whitespace, by `:`).
 *   3. Strings appearing >= 2 times are "interned": hoisted into a top-level
 *      `const _s = [...]` array, indexed by frequency descending (most-common
 *      string gets index 0, fewer digits at each reference).
 *   4. Replace every interned occurrence with `_s[N]`. Single-occurrence
 *      strings stay inline.
 *
 * The transform is a pure string-in / string-out pass; no AST. The emitted
 * code shape is rigid (no eval, no `Function`, no quoted property keys
 * appearing as values) so a tokenizer-level walk is sufficient and avoids
 * pulling acorn / @typescript-eslint/parser in.
 */

interface StringOccurrence {
	/** Start byte index in the source (the opening `"`). */
	start: number;
	/** End byte index (exclusive — points one past the closing `"`). */
	end: number;
	/**
	 * Raw inner source text — what appears between the quotes, escapes
	 * intact. Two literals are equal IFF their inner source matches; this
	 * skips the unescape pass and round-trips bit-exact when re-emitted
	 * inside a fresh `"..."` pair.
	 */
	innerSource: string;
	/** True when this position is a property KEY (do not intern). */
	isKey: boolean;
}

/**
 * Walks `code`, returning every double-quoted string literal with its byte
 * range and key/value classification.
 */
function findStrings(code: string): StringOccurrence[] {
	const out: StringOccurrence[] = [];
	const len = code.length;
	let i = 0;

	while (i < len) {
		const c = code[i];

		if (c === "/" && i + 1 < len) {
			const next = code[i + 1];
			if (next === "/") {
				i += 2;
				while (i < len && code[i] !== "\n") i += 1;
				continue;
			}
			if (next === "*") {
				i += 2;
				while (i < len && !(code[i] === "*" && code[i + 1] === "/")) i += 1;
				i += 2;
				continue;
			}
		}

		if (c === "`") {
			i += 1;
			while (i < len) {
				const tc = code[i];
				if (tc === "\\") {
					i += 2;
					continue;
				}
				if (tc === "`") {
					i += 1;
					break;
				}
				if (tc === "$" && code[i + 1] === "{") {
					i += 2;
					let depth = 1;
					while (i < len && depth > 0) {
						const ic = code[i];
						if (ic === "{") depth += 1;
						else if (ic === "}") depth -= 1;
						else if (ic === '"' || ic === "'") {
							i = skipQuoted(code, i, ic);
							continue;
						} else if (ic === "`") {
							i = skipBacktick(code, i);
							continue;
						}
						i += 1;
					}
					continue;
				}
				i += 1;
			}
			continue;
		}

		if (c === "'") {
			i = skipQuoted(code, i, "'");
			continue;
		}

		if (c === '"') {
			const start = i;
			i += 1;
			while (i < len) {
				const sc = code[i];
				if (sc === "\\") {
					i += 2;
					continue;
				}
				if (sc === '"') {
					i += 1;
					break;
				}
				i += 1;
			}
			const end = i;
			const innerSource = code.slice(start + 1, end - 1);
			const isKey = isPropertyKeyContext(code, end);
			out.push({ start, end, innerSource, isKey });
			continue;
		}

		i += 1;
	}

	return out;
}

function skipQuoted(code: string, start: number, quote: string): number {
	const len = code.length;
	let i = start + 1;
	while (i < len) {
		const c = code[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === quote) {
			return i + 1;
		}
		i += 1;
	}
	return i;
}

function skipBacktick(code: string, start: number): number {
	const len = code.length;
	let i = start + 1;
	while (i < len) {
		const c = code[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "`") return i + 1;
		if (c === "$" && code[i + 1] === "{") {
			i += 2;
			let depth = 1;
			while (i < len && depth > 0) {
				const ic = code[i];
				if (ic === "{") depth += 1;
				else if (ic === "}") depth -= 1;
				i += 1;
			}
			continue;
		}
		i += 1;
	}
	return i;
}

/**
 * After reading a closing `"` at position `end` (exclusive), peek forward
 * past whitespace to see if the next non-whitespace character is `:`. If so,
 * the string was a property key in an object literal and must NOT be interned
 * (replacing `"foo": x` with `_s[N]: x` is a syntax error).
 *
 * Restricted to whitespace-only lookahead — anything else (e.g. a comma,
 * a closing bracket, an operator) means the string was a value or argument.
 */
function isPropertyKeyContext(code: string, end: number): boolean {
	let i = end;
	const len = code.length;
	while (i < len) {
		const c = code[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i += 1;
			continue;
		}
		return c === ":";
	}
	return false;
}

interface InternPlan {
	/** Strings selected for interning, ordered by descending frequency. */
	table: string[];
	/** Map from literal value → index in `table`. */
	indexFor: Map<string, number>;
}

function buildPlan(occurrences: StringOccurrence[]): InternPlan {
	const counts = new Map<string, number>();
	for (const occ of occurrences) {
		if (occ.isKey) continue;
		counts.set(occ.innerSource, (counts.get(occ.innerSource) ?? 0) + 1);
	}
	const eligible: Array<[string, number]> = [];
	for (const [innerSource, count] of counts) {
		if (count >= 2) eligible.push([innerSource, count]);
	}
	// Stable sort: higher count first, then lexicographic. Lexicographic
	// tie-break keeps the table deterministic across builds (Map iteration
	// order is insertion-order in V8 but explicit is safer).
	eligible.sort((a, b) => {
		if (b[1] !== a[1]) return b[1] - a[1];
		return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
	});
	const table = eligible.map(([innerSource]) => innerSource);
	const indexFor = new Map<string, number>();
	for (let idx = 0; idx < table.length; idx += 1) {
		indexFor.set(table[idx], idx);
	}
	return { table, indexFor };
}

/**
 * Hoists the intern table into the source. Insertion point: directly before
 * the first top-level `const`, `let`, `function`, `export`, or other
 * statement that is NOT an `import` declaration. This keeps the table after
 * any `import` lines so module bindings are still in scope when the table
 * is constructed (it is a literal array of strings, but consistency matters).
 */
function findInsertionPoint(code: string): number {
	const importRe = /^(?:import\b[^;\n]*;?[\r\n]*)+/m;
	const match = importRe.exec(code);
	if (match && match.index === 0) {
		return match[0].length;
	}
	return 0;
}

/**
 * Public entry point. Returns the source with strings appearing >=2 times
 * hoisted into a `const _s = [...]` table and replaced with `_s[N]`.
 *
 * If no strings qualify the input is returned unchanged.
 */
export function internStrings(code: string): string {
	const occurrences = findStrings(code);
	const plan = buildPlan(occurrences);
	if (plan.table.length === 0) {
		return code;
	}

	const parts: string[] = [];
	let cursor = 0;
	for (const occ of occurrences) {
		if (occ.isKey) continue;
		const idx = plan.indexFor.get(occ.innerSource);
		if (idx === undefined) continue;
		parts.push(code.slice(cursor, occ.start));
		parts.push(`_s[${idx}]`);
		cursor = occ.end;
	}
	parts.push(code.slice(cursor));
	const rewritten = parts.join("");

	// The table re-wraps each entry's raw inner source in `"..."` exactly as
	// it appeared in the input. No re-escape pass — the raw inner source IS
	// already valid for a double-quoted literal (we extracted it from one).
	const tableLiteral = `const _s = [${plan.table
		.map((s) => `"${s}"`)
		.join(",")}];\n`;
	const insertAt = findInsertionPoint(rewritten);
	return (
		rewritten.slice(0, insertAt) +
		(insertAt > 0 && !rewritten.slice(0, insertAt).endsWith("\n") ? "\n" : "") +
		tableLiteral +
		rewritten.slice(insertAt)
	);
}

export const __test = {
	findStrings,
	buildPlan,
	findInsertionPoint,
};
