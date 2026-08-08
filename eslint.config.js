import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import unicorn from "eslint-plugin-unicorn";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/vitest.config.ts",
      "**/vite.config.ts",
      "**/scripts/**",
      "**/repro-specs/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { unicorn },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "max-params": ["error", 4],
      "max-lines": ["error", { max: 250, skipBlankLines: true, skipComments: true }],
      "unicorn/name-replacements": [
        "error",
        { replacements: { db: false }, allowList: { env: true, deps: true, Deps: true }, ignore: ["e2e"] },
      ],
    },
  },
  eslintConfigPrettier,
  {
    files: ["packages/frontend/src/vite-env.d.ts"],
    rules: {
      "unicorn/name-replacements": "off",
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "max-len": ["error", { code: 150 }],
    },
  },
);
