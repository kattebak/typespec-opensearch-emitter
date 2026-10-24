import type { Model, Type, Union } from "@typespec/compiler";
import {
	isModelUnion,
	isObjectModel,
	restTypeName,
	unionDiscriminator,
} from "./rest-names.js";

/**
 * Where a REST response carries a model union, AppSync needs `__typename` on
 * each value to pick the union member (issue #206). This plans, at emit time,
 * which paths of the response to walk and how each union maps its
 * discriminator to a GraphQL type name. APPSYNC_JS forbids recursion, so a
 * type that reaches itself is walked once and not re-entered.
 */

export type TypenameStep =
	| { kind: "visit"; visitor: string }
	| { kind: "each"; step: TypenameStep };

export interface TypenameObjectVisitor {
	kind: "object";
	name: string;
	fields: Array<{ property: string; step: TypenameStep }>;
}

export interface TypenameUnionVisitor {
	kind: "union";
	name: string;
	discriminator: string;
	variants: Array<{ value: string; typeName: string; visitor?: string }>;
}

export type TypenameVisitor = TypenameObjectVisitor | TypenameUnionVisitor;

export interface TypenamePlan {
	entry: TypenameStep;
	visitors: TypenameVisitor[];
}

export function planTypenames(returnType: Type): TypenamePlan | undefined {
	const visitors = new Map<string, TypenameVisitor>();
	const untagged = new Set<string>();
	const inProgress = new Set<string>();

	function visit(
		name: string,
		build: () => TypenameVisitor | undefined,
	): TypenameStep | undefined {
		if (visitors.has(name)) return { kind: "visit", visitor: name };
		if (inProgress.has(name) || untagged.has(name)) return undefined;
		inProgress.add(name);
		const visitor = build();
		inProgress.delete(name);
		if (!visitor) {
			untagged.add(name);
			return undefined;
		}
		visitors.set(name, visitor);
		return { kind: "visit", visitor: name };
	}

	function stepFor(type: Type): TypenameStep | undefined {
		if (type.kind === "Model" && type.name === "Array" && type.indexer?.value) {
			const step = stepFor(type.indexer.value);
			return step ? { kind: "each", step } : undefined;
		}
		if (isModelUnion(type)) {
			return visit(restTypeName(type), () => unionVisitor(type));
		}
		if (isObjectModel(type)) {
			return visit(restTypeName(type), () => objectVisitor(type));
		}
		return undefined;
	}

	function objectVisitor(model: Model): TypenameObjectVisitor | undefined {
		const fields: TypenameObjectVisitor["fields"] = [];
		for (const property of model.properties.values()) {
			const step = stepFor(property.type);
			if (step) fields.push({ property: property.name, step });
		}
		if (fields.length === 0) return undefined;
		return { kind: "object", name: restTypeName(model), fields };
	}

	function unionVisitor(union: Union): TypenameUnionVisitor {
		const discriminator = unionDiscriminator(union);
		return {
			kind: "union",
			name: restTypeName(union),
			discriminator: discriminator.property,
			variants: discriminator.variants.map(({ value, model }) => {
				const step = stepFor(model);
				return {
					value,
					typeName: restTypeName(model),
					...(step?.kind === "visit" ? { visitor: step.visitor } : {}),
				};
			}),
		};
	}

	const entry = stepFor(returnType);
	if (!entry) return undefined;
	return { entry, visitors: [...visitors.values()] };
}
