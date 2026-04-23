export interface OpenSearchEmitterOptions {
	"output-file"?: string;
}

export const $lib = {
	"emitter-options-schema": {
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
	} as const,
};
