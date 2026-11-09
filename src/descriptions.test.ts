import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderDescription, resolveDescription } from "./descriptions.js";

function makeProgram(docs: Map<unknown, { value: string }>): never {
	return {
		stateMap: (key: symbol) =>
			key.description === "TypeSpec.docs" ? docs : new Map<unknown, unknown>(),
	} as never;
}

describe("resolveDescription (issue #212)", () => {
	it("returns the first target carrying @doc", () => {
		const projectionProperty = { name: "name" };
		const sourceProperty = { name: "name" };
		const program = makeProgram(
			new Map([[sourceProperty, { value: "The pet's name." }]]),
		);

		assert.equal(
			resolveDescription(
				program,
				projectionProperty as never,
				sourceProperty as never,
			),
			"The pet's name.",
		);
	});

	it("prefers an earlier target's @doc over a later one", () => {
		const projectionProperty = { name: "name" };
		const sourceProperty = { name: "name" };
		const program = makeProgram(
			new Map([
				[projectionProperty, { value: "Indexed name." }],
				[sourceProperty, { value: "The pet's name." }],
			]),
		);

		assert.equal(
			resolveDescription(
				program,
				projectionProperty as never,
				sourceProperty as never,
			),
			"Indexed name.",
		);
	});

	it("returns undefined when no target carries @doc", () => {
		const sourceProperty = { name: "name" };
		const program = makeProgram(new Map());

		assert.equal(
			resolveDescription(program, undefined, sourceProperty as never),
			undefined,
		);
	});
});

describe("renderDescription (issue #212)", () => {
	it("renders a block string at the given indentation", () => {
		assert.equal(
			renderDescription("The pet's name.", "  "),
			'  """\n  The pet\'s name.\n  """',
		);
	});

	it("keeps every line of a multi-line description", () => {
		assert.equal(
			renderDescription("First line.\nSecond line.", "  "),
			'  """\n  First line.\n  Second line.\n  """',
		);
	});

	it("escapes a triple quote inside the text", () => {
		assert.equal(renderDescription('A """ block.'), '"""\nA \\""" block.\n"""');
	});

	it("leaves a quote or a backslash at either end alone", () => {
		assert.equal(
			renderDescription('"quoted" and a trailing backslash \\'),
			'"""\n"quoted" and a trailing backslash \\\n"""',
		);
	});

	it("normalizes CRLF to one line per newline", () => {
		assert.equal(
			renderDescription("First line.\r\nSecond line."),
			'"""\nFirst line.\nSecond line.\n"""',
		);
	});

	it("indents no blank line, so the block carries no trailing space", () => {
		assert.equal(
			renderDescription("First line.\n\nSecond line.", "  "),
			'  """\n  First line.\n\n  Second line.\n  """',
		);
	});

	it("renders nothing without text", () => {
		assert.equal(renderDescription(undefined), undefined);
		assert.equal(renderDescription(""), undefined);
	});
});
