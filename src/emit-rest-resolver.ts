import type { RestOperationShape, RestQueryParam } from "./rest-operations.js";

/**
 * APPSYNC_JS resolver codegen for `@restResolver` operations (issue #134).
 * Emits a monolithic request/response pair that proxies a GraphQL field to
 * an AppSync HTTP data source. Per-operation interpolation is limited to
 * `method`, the `resourcePath` template, and the presence of query params /
 * a JSON body — `BASE_HEADERS` and `mapResponse` are invariant shared code.
 */

export interface RestResolverOptions {
	/**
	 * Header name → dotted path into the resolver `ctx`, expanded into
	 * BASE_HEADERS. Absent config yields only `Content-Type`.
	 */
	injectHeaders?: Record<string, string>;
	/**
	 * HTTP status code → GraphQL error type name, merged over the default
	 * (409 → ConflictError, 403 → ForbiddenError). Anything unmapped falls
	 * through to `Http<status>`.
	 */
	errorMap?: Record<string, string>;
	/**
	 * Literal path segment prepended to every generated `resourcePath`.
	 * Must start with `/` and must not end with `/`. Issue #140.
	 */
	resourcePathPrefix?: string;
}

export interface EmittedRestResolverFile {
	typeName: string;
	fieldName: string;
	fileName: string;
	content: string;
}

export const DEFAULT_ERROR_MAP: Record<string, string> = {
	"409": "ConflictError",
	"403": "ForbiddenError",
};

const CTX_PATH_PATTERN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

export function restResolverFileName(op: RestOperationShape): string {
	return `${op.typeName}.${op.fieldName}.js`;
}

export function emitRestResolver(
	op: RestOperationShape,
	options: RestResolverOptions = {},
): EmittedRestResolverFile {
	const content = [
		`import { util } from "@aws-appsync/utils";`,
		"",
		renderBaseHeaders(options.injectHeaders),
		"",
		renderRequest(op, options.resourcePathPrefix),
		"",
		"export function response(ctx) {",
		"\treturn mapResponse(ctx);",
		"}",
		"",
		...(needsQueryString(op) ? [renderQueryString(op), ""] : []),
		renderMapResponse(options.errorMap),
		"",
	].join("\n");

	return {
		typeName: op.typeName,
		fieldName: op.fieldName,
		fileName: restResolverFileName(op),
		content,
	};
}

/**
 * Expands `rest.injectHeaders` (header → dotted ctx path) into the shared
 * BASE_HEADERS factory. Content-Type is always present; injected headers
 * follow in config order. Issue #134.
 */
function renderBaseHeaders(injectHeaders?: Record<string, string>): string {
	const lines = [`\t"Content-Type": "application/json",`];
	for (const [header, ctxPath] of Object.entries(injectHeaders ?? {})) {
		if (!CTX_PATH_PATTERN.test(ctxPath)) {
			throw new Error(
				`rest.injectHeaders["${header}"]: "${ctxPath}" is not a valid dotted ctx path`,
			);
		}
		lines.push(`\t"${header}": ctx.${ctxPath},`);
	}
	return ["const BASE_HEADERS = (ctx) => ({", ...lines, "});"].join("\n");
}

/**
 * `params.query` is a string→string map (AppSync HTTP data source reference),
 * so it cannot hold a repeated key. An exploded array parameter therefore has
 * to be serialized into the resourcePath's own query string instead.
 */
function needsQueryString(op: RestOperationShape): boolean {
	return op.queryParams.some((param) => param.array && param.explode);
}

function queryValueExpression(param: RestQueryParam): string {
	if (!param.array) return `ctx.args.${param.name}`;
	return `ctx.args.${param.name}?.join(",")`;
}

function renderRequest(
	op: RestOperationShape,
	resourcePathPrefix?: string,
): string {
	const paramsLines: string[] = ["\t\t\theaders: BASE_HEADERS(ctx),"];
	if (op.queryParams.length > 0 && !needsQueryString(op)) {
		paramsLines.push("\t\t\tquery: {");
		for (const param of op.queryParams) {
			paramsLines.push(
				`\t\t\t\t"${param.name}": ${queryValueExpression(param)},`,
			);
		}
		paramsLines.push("\t\t\t},");
	}
	if (op.bodyParamName) {
		paramsLines.push(
			`\t\t\tbody: JSON.stringify(ctx.args.${op.bodyParamName}),`,
		);
	}

	const params =
		paramsLines.length === 1
			? `\t\tparams: { headers: BASE_HEADERS(ctx) },`
			: ["\t\tparams: {", ...paramsLines, "\t\t},"].join("\n");

	return [
		"export function request(ctx) {",
		"\treturn {",
		`\t\tmethod: "${op.httpMethod}",`,
		`\t\tresourcePath: ${renderResourcePath(op, resourcePathPrefix)},`,
		params,
		"\t};",
		"}",
	].join("\n");
}

/**
 * Route template → JS expression. Each `{param}` placeholder becomes
 * `${util.urlEncode(ctx.args.<param>)}` inside a template literal; routes
 * without path params render as a plain string literal. An optional
 * `resourcePathPrefix` is prepended verbatim. Issue #140.
 */
function renderResourcePath(
	op: RestOperationShape,
	resourcePathPrefix?: string,
): string {
	const prefix = resourcePathPrefix ?? "";
	const suffix = needsQueryString(op) ? "${queryString(ctx)}" : "";
	if (op.pathParams.length === 0) {
		return suffix
			? `\`${prefix}${op.path}${suffix}\``
			: `"${prefix}${op.path}"`;
	}
	const interpolated = op.path.replace(
		/\{([^}]+)\}/g,
		(_match, name: string) => `\${util.urlEncode(ctx.args.${name})}`,
	);
	return `\`${prefix}${interpolated}${suffix}\``;
}

/**
 * Builds the resourcePath query string for operations carrying an exploded
 * array parameter. Exploded arrays repeat the key, everything else contributes
 * a single pair; absent optional args drop out. APPSYNC_JS has no
 * `Array.isArray`, so the array/scalar split is decided here at emit time.
 */
function renderQueryString(op: RestOperationShape): string {
	const appendLines = op.queryParams.map((param) =>
		param.array && param.explode
			? `\tappendEach(parts, "${param.name}", ctx.args.${param.name});`
			: `\tappend(parts, "${param.name}", ${queryValueExpression(param)});`,
	);

	return [
		"function queryString(ctx) {",
		"\tconst parts = [];",
		...appendLines,
		'\treturn parts.length === 0 ? "" : `?${parts.join("&")}`;',
		"}",
		"",
		"function append(parts, name, value) {",
		"\tif (value === undefined || value === null) return;",
		"\tparts.push(`${name}=${util.urlEncode(`${value}`)}`);",
		"}",
		"",
		"function appendEach(parts, name, values) {",
		"\tif (values === undefined || values === null) return;",
		"\tfor (const value of values) append(parts, name, value);",
		"}",
	].join("\n");
}

/**
 * Shared response mapping: parsed body on 2xx, typed `util.error` otherwise.
 * `errorMap` entries merge over DEFAULT_ERROR_MAP (per-status override);
 * unmapped statuses fall through to `Http<status>`.
 */
function renderMapResponse(errorMap?: Record<string, string>): string {
	const merged = { ...DEFAULT_ERROR_MAP, ...errorMap };
	const statusLines = Object.entries(merged)
		.sort(([a], [b]) => Number(b) - Number(a))
		.map(
			([status, errorType]) =>
				`\tif (statusCode === ${Number(status)}) util.error(parsed?.message ?? body, "${errorType}");`,
		);

	return [
		"function mapResponse(ctx) {",
		"\tconst { statusCode, body } = ctx.result;",
		"\tconst parsed = body ? JSON.parse(body) : null;",
		"\tif (statusCode >= 200 && statusCode < 300) return parsed;",
		...statusLines,
		"\tutil.error(parsed?.message ?? body, `Http${statusCode}`, parsed);",
		"}",
	].join("\n");
}

export const __test = {
	renderBaseHeaders,
	renderRequest,
	renderResourcePath,
	renderQueryString,
	renderMapResponse,
};
