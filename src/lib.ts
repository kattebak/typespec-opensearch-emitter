import { createTypeSpecLibrary, paramMessage } from "@typespec/compiler";

export interface GraphQLEmitterOptions {
	emit?: boolean;
	"default-page-size"?: number;
	"max-page-size"?: number;
	"track-total-hits-up-to"?: number;
	/**
	 * Byte threshold for the monolithic-vs-pipeline switch. Above the
	 * threshold a projection emits as a 3-function pipeline; at or below it
	 * emits as a single UNIT resolver. Default: 28000 (32K AppSync per-file
	 * cap minus headroom). Issue #112.
	 */
	"monolithic-threshold-bytes"?: number;
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
		"invalid-aggregation-kind": {
			severity: "error",
			messages: {
				default: paramMessage`Decorator @aggregatable received unsupported kind "${"kind"}". Allowed kinds: terms, cardinality, missing, sum, avg, min, max, date_histogram, range.`,
			},
		},
		"aggregatable-requires-kind": {
			severity: "error",
			messages: {
				default:
					"Decorator @aggregatable requires at least one aggregation kind argument.",
			},
		},
		"invalid-aggregation-options": {
			severity: "error",
			messages: {
				default: paramMessage`Decorator @aggregatable("${"kind"}", ...) options invalid: ${"reason"}.`,
			},
		},
		"invalid-filterable-kind": {
			severity: "error",
			messages: {
				default: paramMessage`Decorator @filterable received unsupported kind "${"kind"}". Allowed kinds: term, term_negate, terms, exists, range.`,
			},
		},
		"filterable-requires-kind": {
			severity: "error",
			messages: {
				default:
					"Decorator @filterable requires at least one filter kind argument.",
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
		aggregatable: {
			description: "Declare aggregation kinds (terms, cardinality, missing)",
		},
		filterable: {
			description: "Declare filter kinds (term, term_negate, exists, range)",
		},
		searchInfer: {
			description:
				"Model-level marker — infer per-field filter/agg defaults from each property's type",
		},
		searchSkip: {
			description:
				"Field-level marker — opt out of @searchInfer inference for this property",
		},
		sortable: {
			description:
				"Field-level marker — exposes the field on the projection's SortInput",
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
						"monolithic-threshold-bytes": {
							type: "number",
							nullable: true,
							default: 32000,
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
