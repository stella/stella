import { defineConfig } from "oxlint";

import core from "./node_modules/ultracite/config/oxlint/core/index.mjs";
import react from "./node_modules/ultracite/config/oxlint/react/index.mjs";

// All workspaces run oxlint from the repo root via:
//   cd ../.. && oxlint -c oxlint.config.ts --type-aware <workspace-dir>
// Override paths are therefore relative to the repo root.

export default defineConfig({
  extends: [core, react],
  rules: {
    // Override ultracite defaults for Stella
    "no-console": "error",
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
    // Stylistic only; the negated form (`a !== b ? x : y`) is often
    // clearer than the swapped equivalent. No bug-catching value.
    "unicorn/no-negated-condition": "off",
    // Net-positive a11y rule but blanket-disabled here because many
    // role attributes live on coss/Base UI primitives where swapping
    // to a semantic tag breaks composition (e.g. `<div role="row">`
    // inside a non-table grid). Re-enable and clean up per-file.
    "jsx-a11y/prefer-tag-over-role": "off",
    // Disabled: rule misses `<label htmlFor={dynamicId}>` pairs and
    // floods file dialogs with false positives. Re-enable once it
    // supports computed htmlFor.
    "jsx-a11y/control-has-associated-label": "off",
    // Disabled: the `??=` form it suggests can re-trigger
    // `typescript/no-unnecessary-condition` on typed-as-defined
    // properties (e.g. `result.fonts ??= {}`). Pure stylistic anyway.
    "logical-assignment-operators": "off",

    "react/rules-of-hooks": "error",
    "react/style-prop-object": "error",
    "react/jsx-no-comment-textnodes": "error",
    "react/iframe-missing-sandbox": "error",
    "react/jsx-no-script-url": "error",
    "react/button-has-type": "error",
    "react/no-object-type-as-default-prop": "error",
    "promise/always-return": "error",
    "promise/no-return-in-finally": "error",
    "no-useless-assignment": "error",

    // Keep `import/no-cycle` despite its ~20% share of lint time: the
    // Module Side Effects section in CLAUDE.md documents the TDZ class
    // of bugs that circular imports cause with module-level singletons.
    // The rule has 0 current hits, but its job is regression protection.
    "import/no-cycle": "error",

    // Disabled: `verbatimModuleSyntax` is on in the shared tsconfig, so
    // the TypeScript compiler already enforces the type-import semantic.
    // The lint rule only checks the stylistic placement of the `type`
    // keyword inside the import (`import { type X }` vs `import type
    // { X }`) — pure formatting, ~11% of lint time, no bug-catching value.
    "import/consistent-type-specifier-style": "off",

    // Disabled: rule visits ~33k AST nodes to enforce adjacency between
    // get/set accessors for the same property. The codebase models state
    // through plain objects, hooks, and Drizzle queries — class
    // get/set pairs are essentially absent — so the rule fires on
    // nothing while taking ~10% of lint time.
    "eslint/grouped-accessor-pairs": "off",
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
    "no-bare-error/no-bare-error": "error",
    "no-nanoid/no-nanoid": "error",
    "must-use-result/must-use-result": "error",
    "no-any-casts/no-any-casts": "error",
    "no-dangerous-type-assertions/no-dangerous-type-assertions": "error",
    "no-void": ["error", { allowAsStatement: true }],

    "sonarjs/array-callback-without-return": "error",
    "sonarjs/anchor-precedence": "error",
    "sonarjs/code-eval": "error",
    "sonarjs/no-array-delete": "error",
    "sonarjs/no-alphabetical-sort": "error",
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
    "sonarjs/slow-regex": "error",
    "sonarjs/stateful-regex": "error",
    "sonarjs/updated-loop-counter": "error",

    // --- Disabled ultracite defaults ---
    "sort-keys": "off",
    "no-plusplus": "off",
    "no-inline-comments": "off",
    "max-statements": "off",
    "prefer-destructuring": "off",
    "no-negated-condition": "off",
    "no-nested-ternary": "error",
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
    "typescript/no-unnecessary-condition": [
      "error",
      { allowConstantLoopConditions: "only-allowed-literals" },
    ],
    "typescript/no-unnecessary-type-arguments": "error",

    // Redundant with switch-exhaustiveness-check: an exhaustive switch
    // covers every union member by construction, so a `default:` clause
    // would be unreachable. Use exhaustive cases for internal
    // discriminated unions; per-line disable switch-exhaustiveness for
    // genuinely wide enums (OOXML w:numFmt etc.) where default+fallthrough
    // is the intended behaviour.
    "default-case": "off",

    // A `default:` clause is treated as exhaustive. Switches without a
    // default still require every union member to be cased — that's the
    // safety net for discriminated unions (PM content kinds, action
    // types). Switches with an explicit default opt out of the check,
    // which is the right behaviour for catch-all parsers over wide
    // string enums like OOXML w:numFmt.
    "typescript/switch-exhaustiveness-check": [
      "error",
      { considerDefaultExhaustiveForUnions: true },
    ],

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
  ignorePatterns: [
    "**/routeTree.gen.ts",
    "**/*.config.js",
    // Module-augmentation files must use `interface` for declaration
    // merging; oxlint's --fix would rewrite it to `type` and break it.
    "types/**/*.d.ts",
  ],

  jsPlugins: [
    "@tanstack/eslint-plugin-query",
    "@tanstack/eslint-plugin-router",
    "eslint-plugin-drizzle",
    "eslint-plugin-sonarjs",
    "./.oxlint-plugins/no-raw-colors.ts",
    "./.oxlint-plugins/no-raw-foreground-opacity.ts",
    "./.oxlint-plugins/no-inline-style-colors.ts",
    "./.oxlint-plugins/no-physical-properties.ts",
    "./.oxlint-plugins/no-body-ownership-ids.ts",
    "./.oxlint-plugins/no-raw-error-logging.ts",
    "./.oxlint-plugins/no-untyped-updates.ts",
    "./.oxlint-plugins/no-nanoid.ts",
    "./.oxlint-plugins/no-crypto-random-uuid.ts",
    "./.oxlint-plugins/require-router-select.ts",
    "./.oxlint-plugins/no-raw-route-query-client.ts",
    "./.oxlint-plugins/require-safe-route-handlers.ts",
    "./.oxlint-plugins/security-guards.ts",
    "./.oxlint-plugins/no-unbranded-ownership-id-param.ts",
    "./.oxlint-plugins/no-raw-user-id-schema.ts",
    "./.oxlint-plugins/no-offset-pagination.ts",
    "./.oxlint-plugins/mcp-security.ts",
    "./.oxlint-plugins/auth-lifecycle.ts",
    "./.oxlint-plugins/stella-toast.ts",
    "./.oxlint-plugins/no-secret-in-log-sink.ts",
    "./.oxlint-plugins/no-raw-api-url.ts",
    "./.oxlint-plugins/require-fetch-timeout.ts",
    "./.oxlint-plugins/no-bare-error.ts",
    "./.oxlint-plugins/must-use-result.ts",
    "./.oxlint-plugins/no-any-casts.ts",
    "./.oxlint-plugins/no-dangerous-type-assertions.ts",
  ],

  overrides: [
    ...(core.overrides ?? []),
    {
      // Custom oxlint plugin rules traverse AST nodes that the runtime
      // delivers as untyped (effectively `any`). Strict any-flow rules
      // produce noise without real safety here.
      files: [".oxlint-plugins/**/*.ts"],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/strict-boolean-expressions": "off",
      },
    },
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
      // Astro's content config wires virtual loader/schema helpers that
      // oxlint's type-aware pass sees as error-typed outside Astro's checker.
      files: [
        "apps/docs/src/content.config.ts",
        "apps/landing/src/content.config.ts",
      ],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
      },
    },
    {
      // Load-test CLIs intentionally print progress/errors to the
      // terminal; keep product API code on structured logging.
      // (One-off DOCX fixture scripts now live under apps/api/src/scripts,
      // already covered by the **/scripts/** override above.)
      files: ["apps/api/src/tests/load/**/*.ts"],
      rules: { "no-console": "off" },
    },
    {
      // `.claude/mcp/**` is local Claude tooling, not shipped product
      // code. It uses standard Node-style `throw new Error(...)` because
      // it doesn't depend on better-result.
      files: [".claude/mcp/**/*.ts"],
      rules: { "no-bare-error/no-bare-error": "off" },
    },
    {
      // Test-only adapter helper consumed exclusively from
      // `**/*.test.ts`. Not part of any production code path.
      files: [
        "apps/api/src/handlers/case-law/ingestion/adapters/test-utils.ts",
      ],
      rules: { "no-bare-error/no-bare-error": "off" },
    },
    {
      // Legacy DOCX/editor code has parser and layout state machines that need
      // dedicated extraction passes. Keep the rule visible without blocking
      // this guardrail rollout on a broad folio rewrite.
      files: ["packages/folio/src/**/*.{ts,tsx}"],
      rules: { "sonarjs/cognitive-complexity": ["error", 200] },
    },
    {
      // Drizzle schema files are guarded by check-migrations.sh, which
      // requires a new migration on any byte-level change. Keep regex
      // flags off here so adding the rule globally doesn't force an
      // empty migration.
      //
      // The remaining files contain HTML-stripping / markdown-escape /
      // CSS-quoting regexes that CodeQL flags as XSS or escape-bypass
      // when re-analysed. Each has been verified to be safe in context
      // (output is plain text, an HTML AST parser, the CSSOM, or
      // already markdown-escaped upstream), so keep the regexes byte-
      // identical to main and disable the rule here.
      files: [
        "apps/api/src/db/schema.ts",
        "apps/api/src/db/auth-schema.ts",
        "apps/api/src/handlers/case-law/ingestion/adapters/utils.ts",
        "apps/api/src/lib/markdown/html-to-markdown.ts",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/create-property.tsx",
        "packages/folio/src/core/utils/clipboard.ts",
        "packages/folio/src/core/utils/fontResolver.ts",
      ],
      rules: { "require-unicode-regexp": "off" },
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
        "no-raw-foreground-opacity/no-raw-foreground-opacity": "error",
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
                group: ["@stll/*", "@stll/*/**", "!@stll/ui", "!@stll/ui/**"],
                message:
                  "@stll/ui must stay workspace-pure; do not import other Stella workspaces from UI source.",
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
                message: "Use '@stll/api/types' instead of '@/api/'.",
              },
              {
                group: ["@stll/api", "@stll/api/**", "!@stll/api/types"],
                message:
                  "apps/web may only import the public '@stll/api/types' surface.",
              },
              {
                group: [
                  "@stll/desktop",
                  "@stll/desktop/**",
                  "@stll/docs",
                  "@stll/docs/**",
                  "@stll/landing",
                  "@stll/landing/**",
                ],
                message:
                  "apps/web must not import other app workspaces directly.",
              },
              {
                group: ["@stll/ui/components/date-picker-popover"],
                message:
                  "Use '@/components/date-picker-popover' so locale labels are injected.",
              },
            ],
          },
        ],
        "no-raw-api-url/no-raw-api-url": "error",
        "require-router-select/require-router-select": "error",
        "security-guards/no-unsanitized-href": "error",
        "sonarjs/jsx-no-leaked-render": "error",
        "sonarjs/no-hook-setter-in-body": "error",
        "stella-toast/stella-toast": "error",
      },
    },
    {
      files: ["apps/web/src/components/date-picker-popover.tsx"],
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
          },
        ],
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
        "apps/web/src/**/workspace-table/**/*.tsx",
        "apps/web/src/**/sidebar.tsx",
        "apps/web/src/**/template-preview.tsx",
        "apps/web/src/**/page-citation.tsx",
      ],
      rules: { "no-physical-properties/no-physical-properties": "off" },
    },
    {
      files: [
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/pdf/**",
      ],
      rules: {
        "unicorn/prefer-dom-node-remove": "off",
        "unicorn/prefer-dom-node-append": "off",
        "unicorn/prefer-modern-dom-apis": "off",
      },
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
        "require-fetch-timeout/require-fetch-timeout": "error",
      },
    },
    {
      // fetch() without a timeout is allowed in throwaway / non-runtime
      // surfaces: sandbox playground, load tests, build configs, unit
      // tests. Product runtime code (apps/api, apps/web, apps/collab,
      // apps/desktop, packages/*) keeps the guard on.
      files: [
        "apps/playground/**/*.{ts,tsx}",
        "apps/api/src/tests/**/*.ts",
        "**/scripts/**",
        "**/*.test.{ts,tsx}",
        "**/*.config.{ts,tsx}",
      ],
      rules: { "require-fetch-timeout/require-fetch-timeout": "off" },
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
      files: ["apps/api/src/**/*.{ts,tsx}"],
      rules: {
        "auth-lifecycle/after-remove-member-revokes-artifacts": "error",
        "auth-lifecycle/no-direct-auth-artifact-delete": "error",
        "mcp-security/no-direct-oauth-client-join": "error",
        "no-raw-error-logging/no-raw-error-logging": "error",
        "no-secret-in-log-sink/no-secret-in-log-sink": "error",
      },
    },
    {
      files: ["apps/api/src/handlers/mcp-connectors/**/*.{ts,tsx}"],
      rules: {
        "mcp-security/redact-oauth-registration-response": "error",
      },
    },
    {
      files: ["apps/api/src/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "@/api/lib/branded-types",
                importNames: ["toSafeId"],
                message:
                  "Only approved boundary modules and tests may brand raw IDs with toSafeId.",
              },
            ],
          },
        ],
      },
    },
    {
      files: [
        "apps/api/src/lib/auth.ts",
        "apps/api/src/lib/search/**",
        "apps/api/src/lib/safe-id-boundaries.ts",
        "apps/api/src/types.ts",
      ],
      rules: { "no-restricted-imports": "off" },
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

        "typescript/prefer-nullish-coalescing": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "typescript/no-unsafe-return": "off",

        "eslint/no-eq-null": "off",
        "eslint/eqeqeq": "off",
        "no-useless-assignment": "off",
        "typescript/consistent-return": "off",
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

        "eslint/no-eq-null": "off",
        "eslint/eqeqeq": "off",
        "no-useless-assignment": "off",
        "typescript/consistent-return": "off",

        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-argument": "off",

        "typescript/no-deprecated": "off",
        "typescript/promise-function-async": "off",
      },
    },
    {
      // Folio layout bridge, layout painter, layout engine, prosemirror commands,
      // prosemirror conversion, prosemirror plugins, paged-editor,
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

        "eslint/no-eq-null": "off",
        "eslint/eqeqeq": "off",
        "no-useless-assignment": "off",
        "typescript/consistent-return": "off",

        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-argument": "off",

        "typescript/no-deprecated": "off",
        "typescript/promise-function-async": "off",
      },
    },
    {
      // OOXML parsers and serializers operate on fast-xml-parser node trees,
      // slimdom nodes, and JSZip entries — all FFI boundaries that surface as
      // any/Record<string, unknown>. OOXML attribute-string narrowing is now
      // handled by Valibot picklists in parserEnums.ts (see narrowEnum), so
      // typescript/no-unsafe-type-assertion is enforced here; only true FFI
      // boundary files keep the rule off via the override below.
      files: [
        "packages/folio/src/core/docx/**/*.ts",
        "packages/folio/src/core/docx/**/*.tsx",
      ],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/strict-boolean-expressions": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-unnecessary-type-assertion": "off",
        "typescript/prefer-nullish-coalescing": "off",
        "eslint/no-eq-null": "off",
        "eslint/eqeqeq": "off",
        "no-useless-assignment": "off",

        "typescript/promise-function-async": "off",

        "unicorn/no-array-for-each": "off",
        "typescript/no-unnecessary-type-conversion": "off",
        "typescript/no-duplicate-type-constituents": "off",

        "eslint/no-control-regex": "off",
        "typescript/no-deprecated": "off",
        "typescript/consistent-return": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-argument": "off",

        "unicorn/prefer-string-starts-ends-with": "off",
        "typescript/prefer-string-starts-ends-with": "off",
      },
    },
    {
      // FFI-boundary files: fast-xml-parser returns Record<string, unknown>
      // node trees and JSZip exposes _data via an undocumented internal
      // property. The casts at this boundary widen library output back to the
      // shape we know the library produces and cannot be replaced with
      // structural narrowing without giving up the FFI entirely.
      files: [
        "packages/folio/src/core/docx/xmlParser.ts",
        "packages/folio/src/core/docx/unzip.ts",
      ],
      rules: {
        "typescript/no-unsafe-type-assertion": "off",
      },
    },
    {
      // @stll/ares types resolve as error in type-aware linting
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
        "no-offset-pagination/no-offset-pagination": [
          "error",
          {
            // Legacy offset-paginated list endpoints. New list endpoints must
            // use cursor pagination and return Page<T>.
            allowedFiles: [
              "apps/api/src/handlers/billing-codes/read.ts",
              "apps/api/src/handlers/expenses/read.ts",
              "apps/api/src/handlers/invoices/read.ts",
              "apps/api/src/handlers/rates/entries-read.ts",
              "apps/api/src/handlers/rates/read.ts",
              "apps/api/src/handlers/skills/list.ts",
              "apps/api/src/handlers/time-entries/read.ts",
            ],
          },
        ],
        "no-raw-user-id-schema/no-raw-user-id-schema": "error",
        "no-untyped-updates/no-untyped-updates": "error",
        "security-guards/no-unscoped-user-query": "error",
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
              {
                name: "@/api/lib/branded-types",
                importNames: ["toSafeId"],
                message:
                  "Handlers must receive SafeId from macros (workspaceAccessMacro, authMacro) or actor session validation, not construct it from raw strings.",
              },
              {
                name: "@/api/db",
                importNames: ["createScopedDb"],
                message:
                  "Handlers must not construct scoped DB instances from the root db module. Use ctx.scopedDb or createRootScopedDb from lib/root-scoped-db.ts.",
              },
              {
                name: "@/api/db",
                importNames: ["createSafeDb"],
                message:
                  "Handlers must not construct safe DB instances from the root db module. Use ctx.safeDb instead.",
              },
              {
                name: "@/api/db",
                importNames: ["db"],
                message:
                  "Handlers must not import the root db. Use ctx.scopedDb, or move owner-level DB access into a narrow lib helper.",
              },
              {
                name: "@/api/db/root",
                message:
                  "Handlers must not import the root db module. Use ctx.scopedDb, or move owner-level DB access into a narrow lib helper.",
              },
            ],
          },
        ],
      },
    },
    {
      files: [
        "apps/api/src/tests/**",
        "apps/api/**/*.{test,spec}.{ts,tsx,js,jsx}",
        "apps/api/**/__tests__/**/*.{ts,tsx,js,jsx}",
      ],
      rules: { "no-restricted-imports": "off" },
    },
    {
      files: [
        "apps/api/src/handlers/**/routes.ts",
        "apps/api/src/handlers/**/*route.ts",
      ],
      rules: {
        "require-safe-route-handlers/require-safe-route-handlers": "error",
      },
    },
    {
      // Explicit route-boundary exceptions: public/protocol/auth/dev/SSE
      // surfaces do not fit the normal safe-handler endpoint shape.
      files: [
        "apps/api/src/handlers/ai-config/routes.ts",
        "apps/api/src/handlers/auth/routes.ts",
        "apps/api/src/handlers/auth/ui-routes.ts",
        "apps/api/src/handlers/dev/routes.ts",
        "apps/api/src/handlers/entities/desktop-edit-sessions-route.ts",
        "apps/api/src/handlers/folio-collab/routes.ts",
        "apps/api/src/handlers/health/routes.ts",
        "apps/api/src/handlers/mcp/routes.ts",
        "apps/api/src/handlers/verify/routes.ts",
        "apps/api/src/handlers/workspaces/events.ts",
      ],
      rules: {
        "require-safe-route-handlers/require-safe-route-handlers": "off",
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
        "unicorn/prefer-dom-node-append": "off",
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
        "no-bare-error/no-bare-error": "off",
        "no-body-ownership-ids/no-body-ownership-ids": "off",
        "no-raw-user-id-schema/no-raw-user-id-schema": "off",
        "no-untyped-updates/no-untyped-updates": "off",
        "no-unbranded-ownership-id-param/no-unbranded-ownership-id-param":
          "off",
        "no-raw-colors/no-raw-colors": "off",
        "no-physical-properties/no-physical-properties": "off",
        "require-safe-route-handlers/require-safe-route-handlers": "off",
        "security-guards/no-raw-filename-write": "off",
        // Fixture builders legitimately construct partial objects.
        "no-dangerous-type-assertions/no-dangerous-type-assertions": "off",
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
    {
      // Folio docx test fixtures cast XmlElement subtrees and ProseMirror
      // mark.attrs values (typed as `any` at the library boundary) into the
      // shapes the helpers need. Keep no-unsafe-type-assertion off only here
      // so the rule stays live for product code in packages/folio/src/core/docx.
      files: ["packages/folio/src/core/docx/__tests__/**/*.{ts,tsx}"],
      rules: {
        "typescript/no-unsafe-type-assertion": "off",
      },
    },
  ],
});
