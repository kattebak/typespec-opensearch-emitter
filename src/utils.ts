export function toKebabCase(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/[-\s]+/g, "-")
		.toLowerCase();
}
