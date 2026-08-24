import { createTypeSpecLibrary, paramMessage } from "@typespec/compiler";

export interface GraphQLDirectivesOptions {
	/**
	 * Directives applied to every emitted GraphQL type along the response path
	 * (Doc, Connection, Edge, PageInfo, Aggregations, bucket types, nested
	 * struct types) and to the Query field declared in the manifest. Used for
	 * AppSync auth modes — e.g. `["@aws_cognito_user_pools", "@aws_iam"]`.
	 * Per-model `@graphqlDirectives(...)` overrides this list. Issue #121.
	 */
	default?: string[];
}

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
	/**
	 * `buckets` for the `auto_date_histogram` emitted when a
	 * `@aggregatable("date_histogram", ...)` declares no bounds. It is the
	 * ceiling on returned buckets, so it decides how wide a range still keeps
	 * the declared interval before OpenSearch steps to a coarser one. Default:
	 * 10000 — 833 years of monthly buckets, 27 years of daily, and an order of
	 * magnitude under the 65,535 `search.max_buckets` a request may not exceed.
	 * Issue #150.
	 */
	"auto-date-histogram-buckets"?: number;
	directives?: GraphQLDirectivesOptions;
}

export interface RestEmitterOptions {
	/**
	 * Manifest `dataSource` value for REST entries so the CDK consumer knows
	 * which AppSync HTTP data source to attach. Default: "HTTP". Issue #134.
	 */
	dataSourceName?: string;
	/**
	 * Header name → dotted path into the resolver `ctx`, expanded into the
	 * generated BASE_HEADERS (e.g. `x-user-id: identity.resolverContext.userId`
	 * → `"x-user-id": ctx.identity.resolverContext.userId`). Absent config
	 * yields only `Content-Type: application/json`. Issue #134.
	 */
	injectHeaders?: Record<string, string>;
	/**
	 * HTTP status code → GraphQL error type name, merged over the default
	 * (409 → ConflictError, 403 → ForbiddenError; anything else falls through
	 * to `Http<status>`). Issue #134.
	 */
	errorMap?: Record<string, string>;
	/**
	 * Path segment prepended to every `resourcePath` in the generated resolver
	 * and manifest entry. Must start with `/` and must not end with `/`.
	 * Example: `/api/v1`. Default: `""` (current behavior). Issue #140.
	 */
	resourcePathPrefix?: string;
	/**
	 * When set, all REST operations are emitted into a single SDL file with
	 * this name (e.g. `"pets.graphql"`). Each type appears once and there is
	 * a single Query/Mutation block. All manifest entries' `sdlFile` point
	 * at this file. Issue #142.
	 */
	sdlFileName?: string;
}

export interface OpenSearchEmitterOptions {
	"output-file"?: string;
	"default-ignore-above"?: number;
	"package-name"?: string;
	"package-version"?: string;
	graphql?: GraphQLEmitterOptions;
	rest?: RestEmitterOptions;
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
		"search-projection-without-index-name": {
			severity: "warning",
			messages: {
				default: paramMessage`Model "${"name"}" has @searchProjection but no @indexName, so it is emitted as a nested type only: no Query field, no resolver, and no backing index. Declare @indexName to emit it as top-level, or remove @searchProjection if nested-only is intended.`,
			},
		},
		"invalid-index-settings-json": {
			severity: "error",
			messages: {
				default: "@indexSettings value must be valid JSON.",
			},
		},
		"unboundable-date-histogram-interval": {
			severity: "error",
			messages: {
				default: paramMessage`@aggregatable("date_histogram", { interval: "${"interval"}" }) has no bounds, and OpenSearch cannot express a "${"interval"}" floor for auto_date_histogram. This histogram spans whatever range the data holds, so a far-future sentinel date (e.g. 9999-12-31) will exceed search.max_buckets and fail the search. Add bounds: { min, max } to pin the range, or choose an interval auto_date_histogram can floor (year, month, day, hour).`,
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
				default: paramMessage`Decorator @filterable received unsupported kind "${"kind"}". Allowed kinds: term, term_negate, terms, exists, range, prefix, match.`,
			},
		},
		"filterable-requires-kind": {
			severity: "error",
			messages: {
				default:
					"Decorator @filterable requires at least one filter kind argument.",
			},
		},
		"resolver-function-too-large": {
			severity: "error",
			messages: {
				default: paramMessage`Generated AppSync resolver function "${"file"}" is ${"bytes"} bytes, over AppSync's hard 32,768-byte per-function code limit. The pipeline split could not reduce it further — the projection concentrates too much filter/aggregation work in a single nested path. Reduce the @filterable/@aggregatable surface on that path, or split the projection.`,
			},
		},
		"pipeline-too-many-functions": {
			severity: "error",
			messages: {
				default: paramMessage`Projection "${"name"}" needs ${"count"} pipeline functions after the resolver split, over AppSync's limit of 10 functions per pipeline resolver. Reduce the @filterable/@aggregatable surface, or split the projection into narrower documents.`,
			},
		},
		"unsupported-scalar-type": {
			severity: "error",
			messages: {
				default: paramMessage`Field "${"field"}" has scalar type "${"scalar"}", which the OpenSearch mapping cannot express. Emitting it would map the field as "object", which OpenSearch rejects at index time and which silently drops every filter, sort and aggregation on the field. Use a scalar the emitter maps (string, the integer and float families, boolean, plainDate, utcDateTime, offsetDateTime, plainTime, duration), or declare the custom scalar as "scalar ${"scalar"} extends <supported>" so it inherits that mapping.`,
			},
		},
		"unsupported-field-type": {
			severity: "error",
			messages: {
				default: paramMessage`Field "${"field"}" has type kind "${"kind"}", which the OpenSearch mapping cannot express. Emitting it would map the field as "object", which OpenSearch rejects at index time and which silently drops every filter, sort and aggregation on the field. Give the field a scalar, enum, model, array or union-of-scalars type.`,
				union: paramMessage`Field "${"field"}" is a union with no scalar or string variant, so the OpenSearch mapping cannot express it. Emitting it would map the field as "object", which OpenSearch rejects at index time and which silently drops every filter, sort and aggregation on the field. Replace the union with a model whose members are optional, or with a union of scalars.`,
			},
		},
		"unknown-join-key": {
			severity: "error",
			messages: {
				default: paramMessage`Join key "${"key"}" is not a property of model "${"model"}". A join key names a property on the model that owns it: @resolvableBy takes a key on its own model, a "lookup" dependency takes a key on the projection's source model, and an "inbound" dependency takes a key on the joined entity.`,
			},
		},
		"join-index-required": {
			severity: "error",
			messages: {
				default: paramMessage`@dependsOn(${"entity"}, "inbound", ...) discovers every row referencing the driving entity, and that read needs an index to run against. Model "${"entity"}" declares @resolvableBy without one, so it can only be fetched a single row at a time by its own key. Add the index name to that declaration — @resolvableBy(${"entity"}.${"key"}, "${"suggestedIndex"}").`,
			},
		},
		"undeclared-join-resolution": {
			severity: "error",
			messages: {
				default: paramMessage`@dependsOn names model "${"entity"}", which carries no @resolvableBy, so nothing states how a row of it is fetched. Declare @resolvableBy(${"entity"}.<key>) on that model, adding an index name when the join discovers many rows.`,
			},
		},
		"invalid-join-direction": {
			severity: "error",
			messages: {
				default: paramMessage`Decorator @dependsOn received unsupported direction "${"direction"}". Allowed directions: lookup, inbound.`,
			},
		},
		"searchfilter-name-collision": {
			severity: "error",
			messages: {
				default: paramMessage`Two different SearchFilter shapes both resolve to the GraphQL input name "${"typeName"}". This happens when a projection and one of its nested struct models share a base name (e.g. a document "XSearchDoc" with a nested "x: X" field both map to "XSearchFilter"). Rename the nested model (e.g. "XSummary", emitting "XSummarySearchFilter") so each shape gets a distinct input name.`,
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
			description:
				"Declare filter kinds (term, term_negate, terms, exists, range, prefix, match)",
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
		graphqlDirectives: {
			description:
				"GraphQL directives to attach to the model's emitted SDL (e.g. AppSync auth modes)",
		},
		searchProjection: {
			description:
				"Marks a SearchProjection<T> model as a top-level projection (gets a Query field, resolver, OS index, manifest entry); undecorated SearchProjection<T> models are nested-only (issue #123)",
		},
		restResolver: {
			description:
				"Marks an HTTP operation for AppSync JS REST resolver emission (GET → Query field, other verbs → Mutation field) — issue #134",
		},
		graphqlId: {
			description:
				"Opt-in marker — the string property surfaces as GraphQL ID instead of String in REST SDL output (issue #136)",
		},
		resolvableBy: {
			description:
				"How a joined entity is fetched — the key a row is read by, and the index that discovers many rows by that key (issue #194)",
		},
		dependsOn: {
			description:
				"Cross-domain view joins declared on a projection — one entry per joined entity, with its direction and join key (issue #194)",
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
							default: 31000,
						},
						"auto-date-histogram-buckets": {
							type: "number",
							nullable: true,
							default: 10000,
						},
						directives: {
							type: "object",
							nullable: true,
							properties: {
								default: {
									type: "array",
									items: { type: "string" },
									nullable: true,
								},
							},
							additionalProperties: false,
						},
					},
					additionalProperties: false,
				},
				rest: {
					type: "object",
					nullable: true,
					properties: {
						dataSourceName: { type: "string", nullable: true },
						injectHeaders: {
							type: "object",
							nullable: true,
							additionalProperties: { type: "string" },
						},
						errorMap: {
							type: "object",
							nullable: true,
							additionalProperties: { type: "string" },
						},
						resourcePathPrefix: { type: "string", nullable: true },
						sdlFileName: { type: "string", nullable: true },
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
