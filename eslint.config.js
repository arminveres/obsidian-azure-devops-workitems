import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["main.js", "node_modules/**"],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			"@typescript-eslint/consistent-type-imports": [
				"error",
				{
					prefer: "type-imports",
					fixStyle: "inline-type-imports",
					// `typeof import("child_process")` types the lazy require in cliProvider.ts.
					disallowTypeAnnotations: false,
				},
			],
			// Auth providers implement a Promise-returning interface, so some
			// `async` members legitimately have nothing to await.
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/no-floating-promises": "error",
			"no-console": ["warn", { allow: ["warn", "error"] }],
		},
	},
	{
		files: ["*.mjs", "*.js"],
		extends: [tseslint.configs.disableTypeChecked],
		languageOptions: {
			globals: globals.node,
		},
		rules: {
			"no-console": "off",
		},
	},
);
