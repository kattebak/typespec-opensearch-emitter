import appsync from "@aws-appsync/eslint-plugin";

// Emitted resolver code runs in the APPSYNC_JS runtime, which rejects `while`,
// classic `for`, `continue`, `try`/`catch`/`throw`, recursion, regex literals
// and more. Those restrictions are what force the emitter's unrolled blocks and
// fixed-bound worklists, so they need to be checked mechanically rather than by
// substring scan. Scoped to emitted output only — the emitter's own TypeScript
// source is ordinary Node code and biome lints that (`npm run lint`).
export default [
	{
		ignores: [
			"src/**",
			"dist/**",
			"node_modules/**",
			"build/**/tsconfig.json",
			"build/**/*.ts",
		],
	},
	{
		files: ["build/**/*.js", "test/snapshots/**/*.js"],
		...appsync.configs.base,
		languageOptions: {
			...appsync.configs.base.languageOptions,
			ecmaVersion: 2022,
			sourceType: "module",
		},
	},
];
