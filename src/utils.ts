const DATE_SCALAR_NAMES = ["plainDate", "utcDateTime", "offsetDateTime"];

export function isDateScalarName(name: string | undefined): boolean {
	if (!name) return false;
	return DATE_SCALAR_NAMES.includes(name);
}

export function toKebabCase(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/[-\s]+/g, "-")
		.toLowerCase();
}
