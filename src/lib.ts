import { createTypeSpecLibrary, paramMessage } from "@typespec/compiler";

export interface GraphQLEmitterOptions {
	emit?: boolean;
	"default-page-size"?: number;
	"max-page-size"?: number;
	"track-total-hits-up-to"?: number;
}

export interface OpenSearchEmitterOptions {
	"output-file"?: string;
	"default-ignore-above"?: number;
	"package-name"?: string;
	"package-version"?: string;
	graphql?: GraphQLEmitterOptions;
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
		"projection-field-not-on-source": {
			severity: "warning",
			messages: {
				default: paramMessage`Property "${"name"}" on projection model is not a @searchable property on source model ${"sourceModel"} and will be ignored.`,
			},
		},
		"invalid-index-settings-json": {
			severity: "error",
			messages: {
				default: "@indexSettings value must be valid JSON.",
			},
		},
		"positive-boost-required": {
			severity: "error",
			messages: {
				default: "Decorator @boost requires a factor greater than 0.",
			},
		},
		"positive-ignore-above-required": {
			severity: "error",
			messages: {
				default: "Decorator @ignoreAbove requires a limit greater than 0.",
			},
		},
		"non-empty-search-as-required": {
			severity: "error",
			messages: {
				default: "Decorator @searchAs requires a non-empty name string.",
			},
		},
		"spread-field-collision": {
			severity: "error",
			messages: {
				default: paramMessage`Spread field "${"name"}" collides with existing field on projection model.`,
			},
		},
	},
	state: {
		searchable: { description: "Marks a property as searchable" },
		keyword: { description: "Marks a property as keyword" },
		nested: { description: "Marks a property as nested" },
		analyzer: { description: "Analyzer override for a property" },
		boost: { description: "Boost override for a property" },
		ignoreAbove: { description: "ignore_above override for a property" },
		indexName: { description: "Index name override for a projection model" },
		indexSettings: {
			description: "Index settings JSON for a projection model",
		},
		searchAs: {
			description: "Rename a field in projection output",
		},
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
				"default-ignore-above": {
					type: "number",
					nullable: true,
					default: 256,
				},
				"package-name": { type: "string", nullable: true },
				"package-version": { type: "string", nullable: true },
				graphql: {
					type: "object",
					nullable: true,
					properties: {
						emit: { type: "boolean", nullable: true, default: false },
						"default-page-size": {
							type: "number",
							nullable: true,
							default: 20,
						},
						"max-page-size": {
							type: "number",
							nullable: true,
							default: 100,
						},
						"track-total-hits-up-to": {
							type: "number",
							nullable: true,
							default: 10000,
						},
					},
					additionalProperties: false,
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
