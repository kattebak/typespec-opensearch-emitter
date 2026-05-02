import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __test, internStrings } from "./intern.js";

describe("internStrings", () => {
	it("returns input unchanged when no string repeats", () => {
		const src = `const x = "alpha";\nconst y = "beta";\n`;
		assert.equal(internStrings(src), src);
	});

	it("interns a string that appears twice", () => {
		const src = `const a = "foo";\nconst b = "foo";\n`;
		const out = internStrings(src);
		assert.match(out, /^const _s = \["foo"\];/);
		assert.ok(out.includes("const a = _s[0];"));
		assert.ok(out.includes("const b = _s[0];"));
	});

	it("interns multiple strings ordered by descending frequency", () => {
		// "x" appears 3x, "y" 2x, "z" 1x → table = ["x","y"], "z" inline.
		const src = `["x","x","x","y","y","z"]\n`;
		const out = internStrings(src);
		assert.match(out, /^const _s = \["x","y"\];/);
		assert.ok(out.includes('[_s[0],_s[0],_s[0],_s[1],_s[1],"z"]'));
	});

	it("does NOT intern property keys", () => {
		const src = `const o = { "foo": "foo", "foo": "foo" };\n`;
		const out = internStrings(src);
		// "foo" appears 4x as a value+key pair; only the VALUE positions
		// should intern. The KEY positions keep the literal.
		assert.match(out, /"foo":\s*_s\[0\]/);
		// Make sure no `_s[0]:` appears (would be a syntax error).
		assert.ok(!out.includes("_s[0]:"));
	});

	it("does NOT touch strings inside line comments", () => {
		const src = `// "ghost" "ghost"\nconst x = "real";\nconst y = "real";\n`;
		const out = internStrings(src);
		assert.ok(out.includes('// "ghost" "ghost"'));
		assert.ok(out.includes("const x = _s[0];"));
		assert.ok(out.includes("const y = _s[0];"));
	});

	it("does NOT touch strings inside block comments", () => {
		const src = `/* "ghost" appears "ghost" twice */\nconst x = "real";\nconst y = "real";\n`;
		const out = internStrings(src);
		assert.ok(out.includes('/* "ghost" appears "ghost" twice */'));
		assert.ok(out.includes("_s[0]"));
	});

	it("does NOT touch strings inside template literals", () => {
		const src =
			'const t = `say "hi" then "hi"`;\nconst x = "hi";\nconst y = "hi";\n';
		const out = internStrings(src);
		// Template-literal contents stay intact; the two real "hi" outside
		// get interned.
		assert.ok(out.includes('`say "hi" then "hi"`'));
		assert.ok(out.includes("const x = _s[0];"));
		assert.ok(out.includes("const y = _s[0];"));
	});

	it("does NOT touch strings inside single-quoted literals", () => {
		const src = `const a = 'hi'; const b = 'hi'; const c = "hi"; const d = "hi";\n`;
		const out = internStrings(src);
		// Only the double-quoted "hi" pair is interned; single-quoted stay.
		assert.ok(out.includes("'hi'"));
		assert.match(out, /const c = _s\[0\];/);
		assert.match(out, /const d = _s\[0\];/);
	});

	it("hoists the table after import statements", () => {
		const src = `import { util } from "@aws-appsync/utils";\nconst a = "x"; const b = "x";\n`;
		const out = internStrings(src);
		const idxImport = out.indexOf("import");
		const idxTable = out.indexOf("const _s");
		const idxBody = out.indexOf("const a");
		assert.ok(idxImport < idxTable);
		assert.ok(idxTable < idxBody);
	});

	it("hoists the table at file start when there are no imports", () => {
		const src = `const a = "x";\nconst b = "x";\n`;
		const out = internStrings(src);
		assert.ok(out.startsWith("const _s = "));
	});

	it("preserves string semantics — round trip via Function eval", () => {
		const src = `const arr = ["alpha","beta","alpha","gamma","beta","alpha"];\n`;
		const out = internStrings(src);
		const baseline = new Function(`${src}\nreturn arr;`)() as string[];
		const reinterpreted = new Function(`${out}\nreturn arr;`)() as string[];
		assert.deepEqual(reinterpreted, baseline);
	});

	it("handles escape sequences inside strings — table preserves raw inner source", () => {
		// In TS source: `"with \"quotes\""` — the literal value is `with "quotes"`.
		// The interner extracts the raw inner source `with \"quotes\"` and re-wraps
		// it in fresh double quotes, byte-identical to the original.
		const src = `const a = "with \\"quotes\\""; const b = "with \\"quotes\\"";\n`;
		const out = internStrings(src);
		assert.ok(out.includes(`const _s = ["with \\"quotes\\""];`));
		assert.ok(out.includes("const a = _s[0]"));
		// Round-trip: evaluate, both versions must produce the same string value.
		const baseline = new Function(`${src}\nreturn a;`)();
		const interned = new Function(`${out}\nreturn a;`)();
		assert.equal(interned, baseline);
		assert.equal(interned, 'with "quotes"');
	});

	it("does NOT intern a single occurrence", () => {
		const src = `const a = "lonely"; const b = "x"; const c = "x";\n`;
		const out = internStrings(src);
		assert.ok(out.includes('"lonely"'));
		assert.match(out, /const _s = \["x"\];/);
	});

	it("FILTER_SPEC-shape input — interns repeated discriminators and paths", () => {
		const src = `const FILTER_SPEC = [{i:"id",k:"term",f:"id"}, {i:"idIn",k:"terms",f:"id"}, {i:"idExists",k:"exists",f:"id"}];\n`;
		const out = internStrings(src);
		// "id" appears 4x as a VALUE; property keys i/k/f are unquoted.
		// After interning, all 4 "id" value sites become _s[N], no `"id"`
		// remains in the FILTER_SPEC body. The table itself contains "id".
		assert.match(out, /const _s = \[/);
		const filterSpecBody = out.slice(out.indexOf("const FILTER_SPEC"));
		assert.ok(!filterSpecBody.includes('"id"'));
	});

	it("frequency tie-break is deterministic (lexicographic)", () => {
		const src = `["b","b","a","a"]\n`;
		const out = internStrings(src);
		// Both appear twice → sorted lex ascending → "a" gets index 0.
		assert.match(out, /^const _s = \["a","b"\];/);
		assert.ok(out.includes("[_s[1],_s[1],_s[0],_s[0]]"));
	});

	it("findStrings classifies property keys correctly", () => {
		const src = `({ "foo": "bar", "qux": value })`;
		const occurrences = __test.findStrings(src);
		const map = new Map(occurrences.map((o) => [o.innerSource, o.isKey]));
		assert.equal(map.get("foo"), true);
		assert.equal(map.get("bar"), false);
		assert.equal(map.get("qux"), true);
	});
});
