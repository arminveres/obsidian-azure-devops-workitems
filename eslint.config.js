import js from "@eslint/js";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["main.js", "node_modules/**"],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	// Mirrors the automated review that produces the community catalogue scorecard.
	...obsidianmd.configs.recommended,
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
			// Build tooling runs in Node, not in Obsidian.
			"obsidianmd/no-nodejs-modules": "off",
			"no-console": "off",
		},
	},
	{
		rules: {
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					brands: [
						"Azure DevOps",
						"Azure DevOps Server",
						"Azure DevOps Services",
						"Azure CLI",
						"Azure",
						"Microsoft Entra",
						"Microsoft",
						"Obsidian",
						"Markdown",
					],
					acronyms: ["API", "CLI", "HTTPS", "ID", "PAT", "README", "URI", "URL", "WIQL"],
					ignoreWords: ["I"],
					// Literal values and third-party UI labels, not prose the rule can
					// safely rewrite — it turns `dev.azure.com` into `dev.Azure.com`.
					ignoreRegex: [
						"az#",
						"https?://",
						"obsidian://",
						"^myproject$",
						"Work items \\(read\\)",
						"Mobile and desktop applications",
					],
				},
			],
		},
	},
);
