import { type MinifyOptions, minify } from "terser";

/**
 * APPSYNC_JS-safe terser config. The runtime forbids a long list of normally
 * benign JS — `while`, `continue`, C-style `for(;;)`, `++`/`--` (unary increment),
 * regex literals, `try/catch`, recursion, `String()/Number()/Boolean()` global
 * coercion calls. Terser's default optimizations generate several of those
 * (notably `++`/`--`, regex helpers via inlined polyfills, and ternaries that
 * use `void 0`). The config below disables everything that is known to emit
 * a forbidden form, plus the dangerous escape hatches (`unsafe`,
 * `unsafe_arrows`, `unsafe_methods`).
 *
 * The aim is byte shrinkage from string-literal interning + dead-code removal
 * + property mangling of locals. NOT execution speed — the AppSync function
 * is parsed once per cold-start, and the FILTER_SPEC walker is microseconds
 * regardless of variable names. The savings come from the FILTER_SPEC literal
 * (repeated discriminators / path prefixes interned) and from collapsing the
 * fixed renderer scaffolding.
 */
const APPSYNC_SAFE_TERSER_OPTIONS: MinifyOptions = {
	ecma: 2020,
	module: true,
	compress: {
		// Generic safety: disable any "unsafe" optimization family. These can
		// rewrite calls and operators in ways that change observable behavior
		// (or produce constructs APPSYNC_JS rejects).
		unsafe: false,
		unsafe_arrows: false,
		unsafe_comps: false,
		unsafe_Function: false,
		unsafe_math: false,
		unsafe_symbols: false,
		unsafe_methods: false,
		unsafe_proto: false,
		unsafe_regexp: false,
		unsafe_undefined: false,
		// `loops: true` (default) rewrites `for...of` into `while` for some
		// shapes — APPSYNC_JS bans `while`. Keep as-is.
		loops: false,
		// `sequences: true` joins statements with the comma operator, which
		// the APPSYNC_JS deploy validator rejects (INVALID_BINARY_OPERATOR
		// on the `,`). Disable to keep separate statements.
		sequences: false,
		// terser by default rewrites `x = x + 1` → `x++`. APPSYNC_JS bans `++`/`--`.
		// Disable peephole optimizations that produce unary update operators.
		reduce_vars: false,
		evaluate: false,
		// `comparisons` rewrites `!a == b` to `a != b`, which is fine; leave on.
		// `arrows` rewrites function() into () =>; APPSYNC_JS supports arrows.
		// `booleans_as_integers: true` would emit `0`/`1` for true/false in
		// boolean contexts — fine but visually surprising. Leave off (default).
		booleans_as_integers: false,
		// String interning relies on the default `passes: 1` plus terser's
		// internal literal sharing. Multiple passes can introduce `++` via
		// reduce_vars; one pass is enough for the FILTER_SPEC use case.
		passes: 1,
		// Drop nothing — emitter doesn't emit console.* anyway, but be explicit.
		drop_console: false,
		drop_debugger: false,
		// `pure_getters` could elide property access; keep conservative default.
		pure_getters: false,
		// Disable `expression: false` — keep statement-level structure intact
		// so the emitted module exports are not collapsed into expressions
		// (APPSYNC_JS expects top-level `export function ...`).
	},
	// Mangling produces tightly-shadowed identifiers (parameters re-used as
	// const names in inner scopes) that APPSYNC_JS's runtime parser silently
	// mis-resolves at request-evaluation time, even though the AST is valid.
	// Skipping mangle costs ~30% of byte savings but keeps the resolver
	// runnable. The dominant savings come from whitespace removal and
	// FILTER_SPEC literal interning, which compress + literal-folding still
	// achieve.
	mangle: false,
	format: {
		comments: false,
		// `ecma: 2020` permits arrow functions, optional chaining; those are
		// fine in APPSYNC_JS.
	},
};

export async function minifyAppsync(code: string): Promise<string> {
	const result = await minify(code, APPSYNC_SAFE_TERSER_OPTIONS);
	if (typeof result.code !== "string") {
		throw new Error("terser returned no code");
	}
	return result.code;
}

export const __test = {
	APPSYNC_SAFE_TERSER_OPTIONS,
};
