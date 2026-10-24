import type { Model, Type, Union } from "@typespec/compiler";

/**
 * Distinct GraphQL type name for a REST model or union. A plain declaration
 * keeps its bare name. A template instance shares its template's `.name`
 * across every instantiation, so it is disambiguated as
 * `<Arg1><Arg2>...<TemplateName>` when every argument is a named model or a
 * scalar (`TaskDefinitionResultList`, `DecimalAmountFieldValue`) — issues
 * #148 and #206. Any other argument falls back to the bare name.
 */
export function restTypeName(type: Model | Union): string {
	const name = type.name ?? "";
	const args = type.templateMapper?.args;
	if (!args || args.length === 0) return name;

	const argNames = args.map(templateArgName);
	if (argNames.some((argName) => !argName)) return name;

	return `${argNames.join("")}${name}`;
}

function templateArgName(arg: unknown): string | undefined {
	if (!isType(arg)) return undefined;
	if (arg.kind === "Model" && arg.name) return arg.name;
	if (arg.kind === "Scalar") {
		return `${arg.name.charAt(0).toUpperCase()}${arg.name.slice(1)}`;
	}
	return undefined;
}

function isType(value: unknown): value is Type {
	return typeof value === "object" && value !== null && "kind" in value;
}

/**
 * A named union whose every variant is a named object model emits as a
 * GraphQL `union` (issue #206). Any scalar, literal, `null` or array variant
 * keeps the shared scalar mapping.
 */
export function isModelUnion(type: Type): type is Union {
	if (type.kind !== "Union" || !type.name || type.variants.size === 0) {
		return false;
	}
	return [...type.variants.values()].every((variant) =>
		isObjectModel(variant.type),
	);
}

export function isObjectModel(type: Type): type is Model {
	return (
		type.kind === "Model" &&
		!!type.name &&
		type.name !== "Array" &&
		type.name !== "Record"
	);
}

export interface UnionDiscriminator {
	property: string;
	variants: Array<{ value: string; model: Model }>;
}

/**
 * The property every variant of a model union carries as a distinct string
 * literal. AppSync resolves a union member from `__typename`, so the REST
 * resolver needs it to tag each value; a union without one cannot be served.
 */
export function unionDiscriminator(union: Union): UnionDiscriminator {
	const models = [...union.variants.values()]
		.map((variant) => variant.type)
		.filter(isObjectModel);
	for (const candidate of models[0].properties.values()) {
		const values = models.map((model) => {
			const property = model.properties.get(candidate.name);
			return property?.type.kind === "String" ? property.type.value : undefined;
		});
		if (values.some((value) => value === undefined)) continue;
		if (new Set(values).size !== values.length) continue;
		return {
			property: candidate.name,
			variants: models.map((model, index) => ({
				value: values[index] ?? "",
				model,
			})),
		};
	}
	throw new Error(
		`union ${restTypeName(union)}: every variant needs a property with a distinct string-literal value (e.g. kind: "Value") so the REST resolver can set __typename`,
	);
}
