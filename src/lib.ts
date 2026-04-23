import { createTypeSpecLibrary, paramMessage } from "@typespec/compiler";

export interface OpenSearchEmitterOptions {
	"output-file"?: string;
}

export const $lib = createTypeSpecLibrary({
	name: "@kattebak/typespec-opensearch-emitter",
	diagnostics: {
		"string-property-required": {
			severity: "error",
			messages: {
				default: paramMessage`Decorator @${"decorator"} can only be applied to string properties.`,
			},
		},
		"nested-array-model-required": {
			severity: "error",
			messages: {
				default:
					"Decorator @nested can only be applied to array properties whose element type is a model.",
			},
		},
		"positive-boost-required": {
			severity: "error",
			messages: {
				default: "Decorator @boost requires a factor greater than 0.",
			},
		},
	},
	state: {
		searchable: { description: "Marks a property as searchable" },
		keyword: { description: "Marks a property as keyword" },
		nested: { description: "Marks a property as nested" },
		analyzer: { description: "Analyzer override for a property" },
		boost: { description: "Boost override for a property" },
		indexName: { description: "Index name override for a projection model" },
	},
	emitter: {
		options: {
			type: "object",
			additionalProperties: false,
			properties: {
				"output-file": {
					type: "string",
					nullable: true,
					default: "opensearch-projections.json",
				},
			},
			required: [],
		},
	},
});

export const {
	reportDiagnostic,
	createDiagnostic,
	stateKeys: StateKeys,
} = $lib;
