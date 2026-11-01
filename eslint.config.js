import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.es2022,
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["apps/api/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
  },
  {
    files: ["apps/web/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.es2022,
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.es2022,
        ...globals.node,
        fetch: "readonly",
      },
    },
  },
  {
    files: ["apps/web/public/sw.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.es2022,
        ...globals.serviceworker,
      },
    },
  },
);
