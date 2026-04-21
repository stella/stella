import { defineConfig } from "oxlint";
import core from "./node_modules/ultracite/config/oxlint/core/index.mjs";
import react from "./node_modules/ultracite/config/oxlint/react/index.mjs";

// All workspaces run oxlint from the repo root via:
//   cd ../.. && oxlint -c oxlint.config.mjs --type-aware <workspace-dir>
// Override paths are therefore relative to the repo root.

export default defineConfig({
  ...core,
  plugins: [...core.plugins, ...react.plugins],
  rules: {
    ...core.rules,
    ...react.rules,

    // Override ultracite defaults for Stella
    "no-console": "warn",
    "no-shadow": "error",
    "require-await": "error",
    "no-useless-catch": "error",
    "no-non-null-assertion": "error",

    "typescript/no-explicit-any": "error",
    "typescript/no-dynamic-delete": "error",
    "typescript/no-misused-promises": [
      "error",
      { checksVoidReturn: { attributes: false } },
    ],
    "typescript/consistent-type-definitions": ["error", "type"],

    "unicorn/no-useless-undefined": "off",
    "unicorn/prefer-array-find": "error",
    "unicorn/prefer-at": "error",

    "react/rules-of-hooks": "error",

    "import/no-cycle": "error",
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "zod",
            message: "Use 'valibot' instead of 'zod'.",
          },
        ],
      },
    ],
    "no-nanoid/no-nanoid": "error",
    "no-void": ["error", { allowAsStatement: true }],

    // --- Disabled ultracite defaults ---
    "sort-keys": "off",
    "no-plusplus": "off",
    "no-inline-comments": "off",
    "max-statements": "off",
    "prefer-destructuring": "off",
    "no-negated-condition": "off",
    "no-nested-ternary": "off",
    "no-use-before-define": "off",
    "no-useless-return": "off",
    "no-warning-comments": "off",
    "no-unexpected-multiline": "off",
    "max-classes-per-file": "off",
    "class-methods-use-this": "off",
    "no-unmodified-loop-condition": "off",
    "no-loop-func": "off",
    complexity: "off",
    "func-style": "off",
    "func-names": "off",

    "typescript/no-inferrable-types": "off",
    "typescript/consistent-return": "error",
    "typescript/dot-notation": "error",
    "typescript/prefer-readonly": "off",
    "typescript/no-unnecessary-type-conversion": "error",
    "typescript/no-unnecessary-type-arguments": "error",

    "unicorn/switch-case-braces": "off",
    "unicorn/number-literal-case": "off",
    "unicorn/escape-case": "off",
    "unicorn/no-hex-escape": "off",
    "unicorn/prefer-string-replace-all": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/filename-case": "off",
    "unicorn/prefer-response-static-json": "off",
    "unicorn/no-immediate-mutation": "off",
    "unicorn/prefer-ternary": "off",
    "unicorn/no-array-reduce": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/no-useless-spread": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/no-nested-ternary": "off",
    "unicorn/prefer-set-has": "off",
    "unicorn/prefer-spread": "off",

    "react_perf/jsx-no-new-function-as-prop": "off",

    "react/hook-use-state": "off",
    "react/no-array-index-key": "off",
    "react/no-children-prop": "off",
    "react/no-danger": "off",
    "react/jsx-handler-names": "off",

    "import/no-named-as-default-member": "off",
    "import/no-named-as-default": "off",
    "import/no-relative-parent-imports": "off",
    "import/no-namespace": "off",

    "promise/prefer-await-to-then": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/avoid-new": "off",

    "jsdoc/require-param-type": "off",

    "typescript/strict-boolean-expressions": [
      "error",
      { allowNullableString: true, allowNullableBoolean: true },
    ],
    "typescript/no-confusing-void-expression": [
      "error",
      { ignoreArrowShorthand: true, ignoreVoidReturningFunctions: true },
    ],
    "typescript/prefer-nullish-coalescing": [
      "error",
      { ignorePrimitives: { string: true, boolean: true } },
    ],
    "typescript/only-throw-error": [
      "error",
      {
        allow: [
          {
            from: "package",
            name: ["Redirect", "AnyRedirect", "NotFoundError"],
            package: "@tanstack/router-core",
          },
        ],
      },
    ],
    "typescript/return-await": ["error", "error-handling-correctness-only"],
    "typescript/non-nullable-type-assertion-style": "off",
  },
  ignorePatterns: ["**/routeTree.gen.ts", "**/*.config.js"],

  jsPlugins: [
    "@tanstack/eslint-plugin-query",
    "@tanstack/eslint-plugin-router",
    "eslint-plugin-drizzle",
    "eslint-plugin-sonarjs",
    "./.oxlint-plugins/no-raw-colors.ts",
    "./.oxlint-plugins/no-physical-properties.ts",
    "./.oxlint-plugins/no-body-ownership-ids.ts",
    "./.oxlint-plugins/no-untyped-updates.ts",
    "./.oxlint-plugins/no-nanoid.ts",
    "./.oxlint-plugins/require-router-select.ts",
    "./.oxlint-plugins/no-raw-route-query-client.ts",
  ],

  overrides: [
    ...(core.overrides ?? []),
    {
      files: ["**/scripts/**"],
      rules: {
        "no-console": "off",
        // Scripts import from untyped packages and use dynamic data;
        // strict unsafe-any rules add friction without real safety.
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/strict-boolean-expressions": "off",
        "typescript/no-redundant-type-constituents": "off",
      },
    },
    {
      files: ["apps/web/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
      rules: {
        "no-raw-colors/no-raw-colors": "error",
        "no-physical-properties/no-physical-properties": "error",
      },
    },
    {
      files: ["apps/web/src/**/*.{ts,tsx}"],
      rules: {
        "@tanstack/query/exhaustive-deps": "error",
        "@tanstack/query/infinite-query-property-order": "error",
        "@tanstack/query/mutation-property-order": "error",
        "@tanstack/query/no-rest-destructuring": "error",
        "@tanstack/query/no-unstable-deps": "error",
        "@tanstack/query/stable-query-client": "error",
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "zod",
                message: "Use 'valibot' instead of 'zod'.",
              },
            ],
            patterns: [
              {
                group: ["@/api/*", "@/api/**/*"],
                message: "Use '@stella/api/types' instead of '@/api/'.",
              },
            ],
          },
        ],
        "require-router-select/require-router-select": "error",
        "sonarjs/jsx-no-leaked-render": "error",
        "sonarjs/no-hook-setter-in-body": "error",
      },
    },
    {
      files: ["apps/web/src/**/appearance-settings.tsx"],
      rules: { "no-raw-colors/no-raw-colors": "off" },
    },
    {
      files: ["packages/ui/src/**/button.tsx"],
      rules: { "no-raw-colors/no-raw-colors": "off" },
    },
    {
      // Category pills use text-white on dynamic colored backgrounds;
      // left-1/2 is intentional physical centering (paired with -translate-x-1/2)
      files: ["apps/web/src/**/heading-breadcrumb.tsx"],
      rules: {
        "no-raw-colors/no-raw-colors": "off",
        "no-physical-properties/no-physical-properties": "off",
      },
    },
    {
      files: [
        "apps/web/src/**/conversation.tsx",
        "packages/ui/src/**/toast.tsx",
        "packages/ui/src/**/tabs.tsx",
        "apps/web/src/**/_protected.tsx",
        "apps/web/src/**/kanban-column.tsx",
        "apps/web/src/**/workspace-table.tsx",
        "apps/web/src/**/sidebar.tsx",
        "apps/web/src/**/template-preview.tsx",
        "apps/web/src/**/page-citation.tsx",
      ],
      rules: { "no-physical-properties/no-physical-properties": "off" },
    },
    {
      files: ["apps/web/src/routes/**/*.{ts,tsx}"],
      rules: {
        "@tanstack/router/create-route-property-order": "error",
        "no-raw-route-query-client/no-raw-route-query-client": "error",
      },
    },
    {
      files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
      rules: {
        "sonarjs/no-all-duplicated-branches": "error",
        "sonarjs/no-duplicated-branches": "error",
        "sonarjs/no-gratuitous-expressions": "error",
        "sonarjs/no-identical-expressions": "error",
        "sonarjs/no-ignored-return": "error",
        "sonarjs/no-use-of-empty-return-value": "error",
      },
    },
    {
      files: ["apps/api/src/**/*.{ts,tsx}", "apps/api/scripts/**/*.ts"],
      rules: {
        "drizzle/enforce-delete-with-where": [
          "error",
          { drizzleObjectName: ["db", "tx"] },
        ],
        "drizzle/enforce-update-with-where": [
          "error",
          { drizzleObjectName: ["db", "tx"] },
        ],
      },
    },
    {
      // YARA's compile/scan returns loosely-typed RuleMatch; the local
      // Scanner/Match types are strict but oxlint still infers `any`
      // through the yara-x FFI boundary.
      files: ["apps/api/src/lib/file-scan/yara.ts"],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-call": "off",
      },
    },
    {
      // @stella/ares types resolve as error in type-aware linting
      // because the workspace package dist isn't always available
      // during local lint runs.
      files: ["apps/api/src/handlers/contacts/ares-lookup.ts"],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-call": "off",
      },
    },
    {
      files: ["apps/api/src/handlers/**/*.ts"],
      rules: {
        "no-body-ownership-ids/no-body-ownership-ids": "error",
        "no-untyped-updates/no-untyped-updates": "error",
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "zod",
                message: "Use 'valibot' instead of 'zod'.",
              },
              {
                name: "@/api/lib/api-handlers",
                importNames: ["createHandler", "createRootHandler"],
                message:
                  "Use 'createSafeHandler' or 'createSafeRootHandler' instead.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["apps/api/src/handlers/search/search.ts"],
      rules: { "no-body-ownership-ids/no-body-ownership-ids": "off" },
    },
    {
      files: ["apps/api/src/handlers/docx/**/*.ts"],
      rules: {
        "no-untyped-updates/no-untyped-updates": "off",
        "unicorn/prefer-modern-dom-apis": "off",
        "unicorn/prefer-dom-node-remove": "off",
      },
    },
    {
      files: [
        "**/*.{test,spec}.{ts,tsx,js,jsx}",
        "**/__tests__/**/*.{ts,tsx,js,jsx}",
      ],
      plugins: ["jest", "vitest"],
      rules: {
        "jest/no-hooks": "off",
        "jest/no-conditional-in-test": "off",
        "jest/no-conditional-expect": "off",
        "jest/max-expects": "off",
        "jest/require-hook": "off",
        "jest/prefer-each": "off",
        "jest/valid-title": "off",
        "no-console": "off",
        "require-await": "off",
        "typescript/unbound-method": "off",
        "no-body-ownership-ids/no-body-ownership-ids": "off",
        "no-untyped-updates/no-untyped-updates": "off",
        "no-raw-colors/no-raw-colors": "off",
        "no-physical-properties/no-physical-properties": "off",
        "vitest/prefer-importing-vitest-globals": "off",
      },
    },
  ],
});
