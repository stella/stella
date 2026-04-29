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

    "sonarjs/array-callback-without-return": "error",
    "sonarjs/anchor-precedence": "error",
    "sonarjs/code-eval": "error",
    "sonarjs/confidential-information-logging": "error",
    "sonarjs/cognitive-complexity": ["error", 30],
    "sonarjs/existing-groups": "error",
    "sonarjs/no-hardcoded-secrets": "error",
    "sonarjs/no-collection-size-mischeck": "error",
    "sonarjs/no-element-overwrite": "error",
    "sonarjs/no-empty-collection": "error",
    "sonarjs/no-exclusive-tests": "error",
    "sonarjs/no-identical-conditions": "error",
    "sonarjs/no-unthrown-error": "error",
    "sonarjs/no-useless-increment": "error",
    "sonarjs/non-existent-operator": "error",
    "sonarjs/regex-complexity": ["error", { threshold: 30 }],
    "sonarjs/slow-regex": "warn",
    "sonarjs/stateful-regex": "error",
    "sonarjs/updated-loop-counter": "error",

    // --- Disabled ultracite defaults ---
    "sort-keys": "off",
    "no-plusplus": "off",
    "no-inline-comments": "off",
    "max-statements": "off",
    "prefer-destructuring": "off",
    "no-negated-condition": "off",
    // Candidate strict rule, not enabled yet: current code has ~95 findings.
    "no-nested-ternary": "off",
    "no-use-before-define": "off",
    "no-useless-return": "off",
    "no-warning-comments": "off",
    "no-unexpected-multiline": "off",
    "max-classes-per-file": "off",
    "class-methods-use-this": "off",
    "no-unmodified-loop-condition": "off",
    "no-loop-func": "error",
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
    "unicorn/no-array-reduce": "error",
    "unicorn/no-array-sort": "off",
    "unicorn/no-useless-spread": "off",
    "oxc/no-map-spread": "error",
    "unicorn/no-await-expression-member": "off",
    // Candidate strict rule, not enabled yet: overlaps with no-nested-ternary.
    "unicorn/no-nested-ternary": "off",
    "unicorn/prefer-set-has": "error",
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
    "./.oxlint-plugins/no-inline-style-colors.ts",
    "./.oxlint-plugins/no-physical-properties.ts",
    "./.oxlint-plugins/no-body-ownership-ids.ts",
    "./.oxlint-plugins/no-untyped-updates.ts",
    "./.oxlint-plugins/no-nanoid.ts",
    "./.oxlint-plugins/no-crypto-random-uuid.ts",
    "./.oxlint-plugins/require-router-select.ts",
    "./.oxlint-plugins/no-raw-route-query-client.ts",
    "./.oxlint-plugins/security-guards.ts",
    "./.oxlint-plugins/no-unbranded-ownership-id-param.ts",
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
        // Existing scripts are operational glue with argument parsing,
        // process orchestration, and one-off reporting branches. Keep a
        // looser legacy budget while new app/library code starts at 30.
        "sonarjs/cognitive-complexity": ["error", 80],
      },
    },
    {
      // Legacy DOCX/editor code has parser and layout state machines that need
      // dedicated extraction passes. Keep the rule visible without blocking
      // this guardrail rollout on a broad folio rewrite.
      files: ["packages/folio/src/**/*.{ts,tsx}"],
      rules: { "sonarjs/cognitive-complexity": ["error", 200] },
    },
    {
      // Case-law ingestion parsers/adapters intentionally encode many source
      // quirks. Tighten this after parser-specific refactors.
      files: ["apps/api/src/handlers/case-law/ingestion/**/*.ts"],
      rules: { "sonarjs/cognitive-complexity": ["error", 80] },
    },
    {
      // DOCX handlers include document traversal and XML transformation
      // routines. Tighten after splitting the largest transforms.
      files: ["apps/api/src/handlers/docx/**/*.ts"],
      rules: { "sonarjs/cognitive-complexity": ["error", 100] },
    },
    {
      // PDF anonymization/redaction parsing is complex today; keep the global
      // rule for the rest of web while this area gets a focused cleanup.
      files: ["apps/web/src/lib/anonymize/**/*.ts"],
      rules: { "sonarjs/cognitive-complexity": ["error", 80] },
    },
    {
      files: ["packages/template-conditions/src/**/*.ts"],
      rules: { "sonarjs/cognitive-complexity": ["error", 40] },
    },
    {
      files: [
        "apps/web/src/**/*.{ts,tsx}",
        "packages/ui/src/**/*.{ts,tsx}",
        "packages/folio/src/**/*.{ts,tsx}",
      ],
      rules: {
        "no-raw-colors/no-raw-colors": "error",
        "no-inline-style-colors/no-inline-style-colors": "error",
        "no-physical-properties/no-physical-properties": "error",
      },
    },
    {
      files: ["packages/ui/src/**/*.{ts,tsx}"],
      rules: {
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
                group: [
                  "@stella/*",
                  "@stella/*/**",
                  "!@stella/ui",
                  "!@stella/ui/**",
                ],
                message:
                  "@stella/ui must stay workspace-pure; do not import other Stella workspaces from UI source.",
              },
            ],
          },
        ],
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
              {
                group: ["@stella/api", "@stella/api/**", "!@stella/api/types"],
                message:
                  "apps/web may only import the public '@stella/api/types' surface.",
              },
              {
                group: [
                  "@stella/desktop",
                  "@stella/desktop/**",
                  "@stella/docs",
                  "@stella/docs/**",
                  "@stella/landing",
                  "@stella/landing/**",
                ],
                message:
                  "apps/web must not import other app workspaces directly.",
              },
            ],
          },
        ],
        "require-router-select/require-router-select": "error",
        "security-guards/no-unsanitized-href": "error",
        "sonarjs/jsx-no-leaked-render": "error",
        "sonarjs/no-hook-setter-in-body": "error",
      },
    },
    {
      files: ["apps/web/src/**/appearance-settings.tsx"],
      rules: { "no-raw-colors/no-raw-colors": "off" },
    },
    {
      // Color pickers, style galleries, and font pickers legitimately render
      // inline color values as visual previews — not theme-dependent chrome.
      files: [
        "packages/folio/src/**/TableStyleGallery.tsx",
        "packages/folio/src/**/TableBorderPicker.tsx",
        "packages/folio/src/**/TableBorderWidthPicker.tsx",
        "packages/folio/src/**/InsertSymbolDialog.tsx",
        "packages/folio/src/**/FontSizePicker.tsx",
        "packages/folio/src/**/IconGridDropdown.tsx",
        "packages/folio/src/**/TableOptionsDropdown.tsx",
        "packages/folio/src/**/TableMoreDropdown.tsx",
        "packages/folio/src/**/TableMergeButton.tsx",
        "packages/folio/src/**/TableGridPicker.tsx",
        "packages/folio/src/**/ShapeGallery.tsx",
        "packages/folio/src/**/FootnotePropertiesDialog.tsx",
      ],
      rules: { "no-inline-style-colors/no-inline-style-colors": "off" },
    },
    {
      // OOXML color data: palette presets, hex-to-name mappings, table style
      // definitions, and standard color arrays. These are document-format
      // constants, not theme-dependent CSS.
      files: [
        "packages/folio/src/**/toolbarUtils.ts",
        "packages/folio/src/**/table-styles.ts",
        "packages/folio/src/**/colorResolver.ts",
        "packages/folio/src/**/FormattingBar.tsx",
      ],
      rules: { "no-inline-style-colors/no-inline-style-colors": "off" },
    },
    {
      // Eigenpal-inherited dialog/edit components: inline colors need
      // a dedicated cleanup pass. Tracked as follow-up.
      files: [
        "packages/folio/src/**/dialogs/**",
        "packages/folio/src/**/edit/**",
      ],
      rules: { "no-inline-style-colors/no-inline-style-colors": "off" },
    },
    {
      // Eigenpal-inherited UI components with hardcoded chrome colors
      files: [
        "packages/folio/src/**/HyperlinkPopup.tsx",
        "packages/folio/src/**/MenuDropdown.tsx",
        "packages/folio/src/**/DocumentOutline.tsx",
        "packages/folio/src/**/InlineHeaderFooterEditor.tsx",
        "packages/folio/src/**/ErrorBoundary.tsx",
        "packages/folio/src/**/UnsavedIndicator.tsx",
        "packages/folio/src/**/TableGridInline.tsx",
        "packages/folio/src/**/ResponsiveToolbar.tsx",
        "packages/folio/src/**/PrintPreview.tsx",
        "packages/folio/src/**/TableQuickActions.tsx",
      ],
      rules: { "no-inline-style-colors/no-inline-style-colors": "off" },
    },
    {
      files: ["packages/ui/src/**/button.tsx"],
      rules: {
        "no-raw-colors/no-raw-colors": "off",
        "no-inline-style-colors/no-inline-style-colors": "off",
      },
    },
    {
      // Color picker presets and gradients are color data, not theme-dependent chrome.
      files: [
        "packages/ui/src/**/color-picker.tsx",
        "packages/ui/src/**/hex-color-picker.tsx",
      ],
      rules: {
        "no-inline-style-colors/no-inline-style-colors": "off",
        "no-raw-colors/no-raw-colors": "off",
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
        "security-guards/no-raw-filename-write": "error",
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
      // ProseMirror's node.attrs and mark.attrs are typed as
      // { readonly [attr: string]: any } — a library FFI boundary.
      // toDOM and parseDOM callbacks must cast attrs to their typed shapes,
      // and NodeSpec/MarkSpec do not support generic type parameters.
      // Extension commands also read attrs via the same any-typed API.
      files: [
        "packages/folio/src/core/prosemirror/extensions/**/*.ts",
        "packages/folio/src/core/prosemirror/extensions/**/*.tsx",
      ],
      rules: {
        "typescript/no-unsafe-type-assertion": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/strict-boolean-expressions": "off",
        "typescript/no-base-to-string": "off",
        "typescript/prefer-nullish-coalescing": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/restrict-template-expressions": "off",
        "typescript/switch-exhaustiveness-check": "off",
        "eslint/no-eq-null": "off",
        "eslint/eqeqeq": "off",
        "typescript/consistent-return": "off",
        "unicorn/no-useless-collection-argument": "off",
      },
    },
    {
      // Folio React components and hooks interact directly with ProseMirror
      // state (node.attrs typed as any), OOXML data structures, and DOM APIs
      // requiring HTMLElement subtype casts. Same FFI boundary as extensions.
      files: [
        "packages/folio/src/components/**/*.ts",
        "packages/folio/src/components/**/*.tsx",
        "packages/folio/src/hooks/**/*.ts",
        "packages/folio/src/hooks/**/*.tsx",
        "packages/folio/src/*.ts",
        "packages/folio/src/*.tsx",
      ],
      rules: {
        "typescript/no-unsafe-type-assertion": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/strict-boolean-expressions": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "typescript/prefer-nullish-coalescing": "off",
        "typescript/switch-exhaustiveness-check": "off",
        "eslint/no-eq-null": "off",
        "eslint/eqeqeq": "off",
        "typescript/consistent-return": "off",
        "typescript/no-base-to-string": "off",
        "typescript/restrict-template-expressions": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/consistent-type-imports": "off",
        "typescript/prefer-regexp-exec": "off",
        "typescript/no-redundant-type-constituents": "off",
        "typescript/no-deprecated": "off",
        "typescript/promise-function-async": "off",
        "typescript/no-unnecessary-type-arguments": "off",
        "typescript/prefer-includes": "off",
        "typescript/no-floating-promises": "off",
        "typescript/use-unknown-in-catch-callback-variable": "off",
      },
    },
    {
      // Folio layout bridge, layout painter, layout engine, prosemirror commands,
      // prosemirror conversion, prosemirror plugins, plugin-api, paged-editor,
      // managers, and utils all work with ProseMirror's any-typed node.attrs and
      // DOM APIs that return HTMLElement subtypes requiring narrowing casts.
      files: [
        "packages/folio/src/core/layout-bridge/**/*.ts",
        "packages/folio/src/core/layout-bridge/**/*.tsx",
        "packages/folio/src/core/layout-painter/**/*.ts",
        "packages/folio/src/core/layout-painter/**/*.tsx",
        "packages/folio/src/core/layout-engine/**/*.ts",
        "packages/folio/src/core/layout-engine/**/*.tsx",
        "packages/folio/src/core/prosemirror/conversion/**/*.ts",
        "packages/folio/src/core/prosemirror/conversion/**/*.tsx",
        "packages/folio/src/core/prosemirror/commands/**/*.ts",
        "packages/folio/src/core/prosemirror/commands/**/*.tsx",
        "packages/folio/src/core/prosemirror/plugins/**/*.ts",
        "packages/folio/src/core/prosemirror/plugins/**/*.tsx",
        "packages/folio/src/core/prosemirror/*.ts",
        "packages/folio/src/core/prosemirror/*.tsx",
        "packages/folio/src/core/prosemirror/**/*.ts",
        "packages/folio/src/core/prosemirror/**/*.tsx",
        "packages/folio/src/core/managers/**/*.ts",
        "packages/folio/src/core/managers/**/*.tsx",
        "packages/folio/src/core/utils/**/*.ts",
        "packages/folio/src/core/utils/**/*.tsx",
        "packages/folio/src/core/types/**/*.ts",
        "packages/folio/src/plugin-api/**/*.ts",
        "packages/folio/src/plugin-api/**/*.tsx",
        "packages/folio/src/paged-editor/**/*.ts",
        "packages/folio/src/paged-editor/**/*.tsx",
      ],
      rules: {
        "typescript/no-unsafe-type-assertion": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/strict-boolean-expressions": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "typescript/prefer-nullish-coalescing": "off",
        "typescript/switch-exhaustiveness-check": "off",
        "eslint/no-eq-null": "off",
        "eslint/eqeqeq": "off",
        "typescript/consistent-return": "off",
        "typescript/no-base-to-string": "off",
        "typescript/restrict-template-expressions": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/consistent-type-imports": "off",
        "typescript/prefer-regexp-exec": "off",
        "typescript/no-redundant-type-constituents": "off",
        "typescript/no-deprecated": "off",
        "typescript/promise-function-async": "off",
      },
    },
    {
      // OOXML/slimdom parsers cast XML node values to typed shapes.
      // slimdom's DOM APIs (getAttribute, childNodes, etc.) return `any`;
      // the parser functions narrow these to the correct OOXML types via assertion.
      // Serializer files write back to slimdom nodes with the same any-typed API.
      files: [
        "packages/folio/src/core/docx/**/*.ts",
        "packages/folio/src/core/docx/**/*.tsx",
      ],
      rules: {
        "typescript/no-unsafe-type-assertion": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/strict-boolean-expressions": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "typescript/prefer-nullish-coalescing": "off",
        "eslint/no-eq-null": "off",
        "eslint/eqeqeq": "off",
        "typescript/switch-exhaustiveness-check": "off",
        "typescript/promise-function-async": "off",
        "typescript/prefer-regexp-exec": "off",
        "unicorn/no-array-for-each": "off",
        "typescript/no-unnecessary-type-conversion": "off",
        "typescript/no-duplicate-type-constituents": "off",
        "typescript/no-redundant-type-constituents": "off",
        "eslint/no-control-regex": "off",
        "typescript/no-deprecated": "off",
        "typescript/consistent-return": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/restrict-template-expressions": "off",
        "typescript/no-base-to-string": "off",
        "unicorn/prefer-string-starts-ends-with": "off",
        "typescript/prefer-string-starts-ends-with": "off",
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
      files: ["apps/api/**/*.ts"],
      rules: {
        "no-crypto-random-uuid/no-crypto-random-uuid": "error",
      },
    },
    {
      files: ["apps/api/src/handlers/**/*.ts", "apps/api/src/lib/**/*.ts"],
      rules: {
        "no-unbranded-ownership-id-param/no-unbranded-ownership-id-param":
          "error",
      },
    },
    {
      // Brand-minting boundary: these files must accept raw strings
      // and produce SafeId values; the rule cannot help here.
      files: [
        "apps/api/src/lib/branded-types.ts",
        "apps/api/src/lib/safe-id-boundaries.ts",
      ],
      rules: {
        "no-unbranded-ownership-id-param/no-unbranded-ownership-id-param":
          "off",
      },
    },
    {
      files: ["apps/api/src/handlers/**/*.ts"],
      rules: {
        "no-body-ownership-ids/no-body-ownership-ids": "error",
        "no-untyped-updates/no-untyped-updates": "error",
        "security-guards/no-unscoped-user-query": "warn",
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
        "require-yield": "off",
        "typescript/unbound-method": "off",
        "no-body-ownership-ids/no-body-ownership-ids": "off",
        "no-untyped-updates/no-untyped-updates": "off",
        "no-unbranded-ownership-id-param/no-unbranded-ownership-id-param":
          "off",
        "no-raw-colors/no-raw-colors": "off",
        "no-physical-properties/no-physical-properties": "off",
        "security-guards/no-raw-filename-write": "off",
        "security-guards/no-unsanitized-href": "off",
        "security-guards/no-unscoped-user-query": "off",
        "vitest/prefer-importing-vitest-globals": "off",
        // bun:test globals (describe/test/expect/it/…) resolve as `error` type
        // when test files are excluded from the main tsconfig (packages/folio).
        // Suppressing unsafe rules for test files avoids false positives that
        // would require modifying every test or adding a separate tsconfig.
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/strict-boolean-expressions": "off",
      },
    },
  ],
});
