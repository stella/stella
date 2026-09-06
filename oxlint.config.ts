import { defineConfig } from "oxlint";
import type { OxlintOverride } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";

import {
  libraryIgnorePatterns,
  libraryOverrides,
  libraryRules,
  stellaLowercasePluginSpecifier,
} from "@stll/oxlint-config";

import { OWNERSHIP } from "./scripts/ownership.ts";
import {
  RESULT_CONVENTION_ENABLED_GLOBS,
  RESULT_CONVENTION_EXCLUDE_GLOBS,
} from "./scripts/result-boundary-globs.ts";

// All workspaces run oxlint from the repo root via:
//   cd ../.. && oxlint -c oxlint.config.ts --type-aware <workspace-dir>
// Override paths are therefore relative to the repo root.

const fixtureRuleOverride = (file: string, rules: readonly string[]) => ({
  files: [`.oxlint-plugins/__fixtures__/${file}`],
  rules: Object.fromEntries(rules.map((rule) => [rule, "error"] as const)),
});

// Only the rows that declare an enforcement kind reach the lint rule; the rest
// document an owner that no rule can yet prove.
const enforcedOwnershipEntries = OWNERSHIP.filter(
  (entry) => entry.enforcement.kind !== "none",
);

const PUBLIC_SSR_AMBIENT_STATE_MESSAGE =
  "Public SSR modules must use a hydration-safe adapter with a deterministic server snapshot.";
const publicSsrBrowserGlobals = [
  "devicePixelRatio",
  "document",
  "history",
  "innerHeight",
  "innerWidth",
  "localStorage",
  "location",
  "matchMedia",
  "navigator",
  "outerHeight",
  "outerWidth",
  "pageXOffset",
  "pageYOffset",
  "screen",
  "scrollX",
  "scrollY",
  "self",
  "sessionStorage",
  "visualViewport",
  "window",
].map((name) => ({ name, message: PUBLIC_SSR_AMBIENT_STATE_MESSAGE }));
const publicSsrDateNowRestriction = {
  object: "Date",
  property: "now",
  message: PUBLIC_SSR_AMBIENT_STATE_MESSAGE,
};
const publicSsrAmbientProperties = [
  {
    object: "Date",
    property: "parse",
    message: PUBLIC_SSR_AMBIENT_STATE_MESSAGE,
  },
  {
    object: "Math",
    property: "random",
    message: PUBLIC_SSR_AMBIENT_STATE_MESSAGE,
  },
  {
    object: "crypto",
    property: "getRandomValues",
    message: PUBLIC_SSR_AMBIENT_STATE_MESSAGE,
  },
  {
    object: "crypto",
    property: "randomUUID",
    message: PUBLIC_SSR_AMBIENT_STATE_MESSAGE,
  },
  {
    object: "performance",
    property: "now",
    message: PUBLIC_SSR_AMBIENT_STATE_MESSAGE,
  },
  ...[
    "Collator",
    "DateTimeFormat",
    "DisplayNames",
    "ListFormat",
    "NumberFormat",
    "PluralRules",
    "RelativeTimeFormat",
    "Segmenter",
  ].map((property) => ({
    object: "Intl",
    property,
    message: PUBLIC_SSR_AMBIENT_STATE_MESSAGE,
  })),
];
const publicSsrAmbientStateRules = {
  "no-restricted-globals": [
    "error",
    { globals: publicSsrBrowserGlobals, checkGlobalObject: true },
  ],
  "no-restricted-properties": [
    "error",
    publicSsrDateNowRestriction,
    ...publicSsrAmbientProperties,
  ],
} satisfies NonNullable<OxlintOverride["rules"]>;

const fixtureRuleOverrides = [
  {
    files: [".oxlint-plugins/__fixtures__/public-ssr-ambient-state.fixture.ts"],
    rules: publicSsrAmbientStateRules,
  },
  fixtureRuleOverride("auth-lifecycle.fixture.ts", [
    "auth-lifecycle/after-remove-member-revokes-artifacts",
    "auth-lifecycle/no-direct-auth-artifact-delete",
  ]),
  fixtureRuleOverride("forbid-process-env-outside-env-ts.fixture.ts", [
    "forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts",
  ]),
  fixtureRuleOverride("forbid-dev-runner-config-reads.fixture.ts", [
    "forbid-dev-runner-config-reads/forbid-dev-runner-config-reads",
  ]),
  fixtureRuleOverride("docs-source-policy.fixture.ts", [
    "docs-source-policy/docs-source-policy",
  ]),
  fixtureRuleOverride("mcp-security.fixture.ts", [
    "mcp-security/no-direct-oauth-client-join",
    "mcp-security/redact-oauth-registration-response",
  ]),
  fixtureRuleOverride("no-async-context-enter-with.fixture.ts", [
    "no-async-context-enter-with/no-async-context-enter-with",
  ]),
  fixtureRuleOverride("no-ambient-nondeterminism.fixture.ts", [
    "no-ambient-nondeterminism/no-ambient-nondeterminism",
  ]),
  fixtureRuleOverride("require-cn-for-classname-composition.fixture.tsx", [
    "require-cn-for-classname-composition/require-cn-for-classname-composition",
  ]),
  fixtureRuleOverride("no-body-ownership-ids.fixture.ts", [
    "no-body-ownership-ids/no-body-ownership-ids",
  ]),
  fixtureRuleOverride("no-crypto-random-uuid.fixture.ts", [
    "no-crypto-random-uuid/no-crypto-random-uuid",
  ]),
  fixtureRuleOverride("no-inline-endpoint-in-routes.fixture.ts", [
    "no-inline-endpoint-in-routes/no-inline-endpoint-in-routes",
  ]),
  fixtureRuleOverride("no-inline-style-colors.fixture.tsx", [
    "no-inline-style-colors/no-inline-style-colors",
  ]),
  fixtureRuleOverride("no-ambient-hotkey-format.fixture.ts", [
    "no-ambient-hotkey-format/no-ambient-hotkey-format",
  ]),
  fixtureRuleOverride("no-offset-pagination.fixture.ts", [
    "no-offset-pagination/no-offset-pagination",
  ]),
  fixtureRuleOverride("no-optional-mutation-command.fixture.ts", [
    "no-optional-mutation-command/no-optional-mutation-command",
  ]),
  fixtureRuleOverride("no-physical-properties.fixture.ts", [
    "no-physical-properties/no-physical-properties",
  ]),
  fixtureRuleOverride("no-raw-api-url.fixture.ts", [
    "no-raw-api-url/no-direct-api-env",
    "no-raw-api-url/no-raw-api-url",
  ]),
  fixtureRuleOverride("no-raw-resource-uri.fixture.ts", [
    "no-raw-resource-uri/no-raw-resource-uri",
    "no-raw-resource-uri/require-rfc3986-resource-encoding",
  ]),
  fixtureRuleOverride("no-raw-error-logging.fixture.ts", [
    "no-raw-error-logging/no-raw-error-logging",
  ]),
  fixtureRuleOverride("no-redacted-log-attribute-key.fixture.ts", [
    "no-redacted-log-attribute-key/no-redacted-log-attribute-key",
  ]),
  fixtureRuleOverride("no-raw-foreground-opacity.fixture.ts", [
    "no-raw-foreground-opacity/no-raw-foreground-opacity",
  ]),
  fixtureRuleOverride("no-raw-public-law-seo.fixture.ts", [
    "no-raw-public-law-seo/no-raw-public-law-seo",
  ]),
  fixtureRuleOverride("no-raw-router-invalidation.fixture.ts", [
    "no-raw-router-invalidation/no-raw-router-invalidation",
  ]),
  fixtureRuleOverride("no-raw-user-id-schema.fixture.ts", [
    "no-raw-user-id-schema/no-raw-user-id-schema",
  ]),
  fixtureRuleOverride("no-adhoc-loader.fixture.tsx", [
    "no-adhoc-loader/no-adhoc-loader",
  ]),
  fixtureRuleOverride("no-dialog-trigger-menu-item.fixture.tsx", [
    "no-dialog-trigger-menu-item/no-dialog-trigger-menu-item",
  ]),
  fixtureRuleOverride("no-secret-in-log-sink.fixture.ts", [
    "no-secret-in-log-sink/no-secret-in-log-sink",
  ]),
  fixtureRuleOverride("no-unbranded-ownership-id-param.fixture.ts", [
    "no-unbranded-ownership-id-param/no-unbranded-ownership-id-param",
  ]),
  fixtureRuleOverride("no-direct-property-table-write.fixture.ts", [
    "no-direct-property-table-write/no-direct-property-table-write",
  ]),
  fixtureRuleOverride("no-direct-template-version-write.fixture.ts", [
    "no-direct-template-version-write/no-direct-template-version-write",
  ]),
  fixtureRuleOverride("no-condition-combinator-outside-conditions.fixture.ts", [
    "no-condition-combinator-outside-conditions/no-condition-combinator-outside-conditions",
  ]),
  fixtureRuleOverride(
    "no-condition-combinator-outside-conditions.fixture.type-import.ts",
    [
      "no-condition-combinator-outside-conditions/no-condition-combinator-outside-conditions",
    ],
  ),
  fixtureRuleOverride("no-unjustified-double-assertion.fixture.ts", [
    "no-unjustified-double-assertion/no-unjustified-double-assertion",
  ]),
  fixtureRuleOverride("no-untranslated-jsx-literal.fixture.tsx", [
    "no-untranslated-jsx-literal/no-untranslated-jsx-literal",
  ]),
  fixtureRuleOverride("no-untyped-updates.fixture.ts", [
    "no-untyped-updates/no-untyped-updates",
  ]),
  fixtureRuleOverride("no-direct-buffer-cleanup-intent-delete.fixture.ts", [
    "no-direct-buffer-cleanup-intent-delete/no-direct-buffer-cleanup-intent-delete",
  ]),
  fixtureRuleOverride("public-case-law-db-boundary.fixture.ts", [
    "public-case-law-db-boundary/public-case-law-db-boundary",
  ]),
  fixtureRuleOverride("public-law-read-boundary.fixture.ts", [
    "public-law-read-boundary/require-language-alternate-counts",
    "public-law-read-boundary/require-configured-read-transaction",
  ]),
  fixtureRuleOverride("require-audit-on-mutation.fixture.ts", [
    "require-audit-on-mutation/require-audit-on-mutation",
  ]),
  fixtureRuleOverride("require-buffer-cleanup-intent-status.fixture.ts", [
    "require-buffer-cleanup-intent-status/require-buffer-cleanup-intent-status",
  ]),
  fixtureRuleOverride("require-derived-check-enum.fixture.ts", [
    "require-derived-check-enum/require-derived-check-enum",
  ]),
  fixtureRuleOverride("require-eden-error-check.fixture.ts", [
    "require-eden-error-check/require-eden-error-check",
  ]),
  fixtureRuleOverride("require-fetch-timeout.fixture.ts", [
    "require-fetch-timeout/require-fetch-timeout",
  ]),
  fixtureRuleOverride("require-file-transport-disposition.fixture.ts", [
    "require-file-transport-disposition/require-file-transport-disposition",
  ]),
  fixtureRuleOverride("require-router-select.fixture.ts", [
    "require-router-select/require-router-select",
  ]),
  fixtureRuleOverride("require-contained-handler.fixture.tsx", [
    "require-contained-handler/no-portal-under-interactive-ancestor",
    "require-contained-handler/require-contained-handler",
  ]),
  fixtureRuleOverride("require-complete-compaction-generation.fixture.ts", [
    "require-complete-compaction-generation/require-complete-compaction-generation",
  ]),
  fixtureRuleOverride("require-safe-route-handlers.fixture.ts", [
    "require-safe-route-handlers/require-safe-route-handlers",
  ]),
  fixtureRuleOverride("require-safe-outbound-target.fixture.ts", [
    "require-safe-outbound-target/require-safe-outbound-target",
  ]),
  fixtureRuleOverride("require-transaction-abort.fixture.ts", [
    "require-transaction-abort/require-transaction-abort",
  ]),
  fixtureRuleOverride("security-guards.fixture.tsx", [
    "security-guards/no-raw-filename-write",
    "security-guards/no-unsanitized-href",
    "security-guards/no-unscoped-user-query",
    "security-guards/require-secure-document-response",
  ]),
  fixtureRuleOverride("require-query-key-factory.fixture.ts", [
    "require-query-key-factory/require-query-key-factory",
  ]),
  fixtureRuleOverride("stella-toast.fixture.ts", ["stella-toast/stella-toast"]),
  fixtureRuleOverride("suppression-hygiene.fixture.ts", [
    "suppression-hygiene/no-foreign-directive",
    "suppression-hygiene/require-description",
  ]),
  fixtureRuleOverride("no-throw-outside-boundary.fixture.ts", [
    "no-throw-outside-boundary/no-throw-outside-boundary",
  ]),
  fixtureRuleOverride("no-try-catch-outside-boundary.fixture.ts", [
    "no-try-catch-outside-boundary/no-try-catch-outside-boundary",
  ]),
];

const browserSurfaceFiles = [
  "apps/web/src/**/*.{ts,tsx}",
  "apps/desktop/src/**/*.{ts,tsx}",
  "apps/landing/src/**/*.{ts,tsx}",
  "apps/playground/src/**/*.{ts,tsx}",
  "packages/ui/src/**/*.{ts,tsx}",
] as const;

// Shared `no-restricted-imports` entries.
//
// Oxlint resolves overrides by replacement, not by merge: for a given file the
// last override that mentions a rule supplies that rule's entire
// configuration. A scope that adds one import restriction therefore has to
// restate every restriction it inherits from the base rule and from the
// broader overrides that also match its files, or those bans silently stop
// being reported. Compose each scope from the groups below instead of
// retyping them; `scripts/oxlint-override-union.test.ts` fails when a scope
// drops an inherited entry without a declared reason.
const noZodImport = {
  name: "zod",
  message: "Use 'valibot' instead of 'zod'.",
};

const webLocalApiImportGroup = [
  "@/api/*",
  "@/api/**/*",
  "!@/api/handlers/chat/types",
];

const webProtectedRouteImportGroup = [
  "@/routes/_protected",
  "@/routes/_protected/**",
  "@/routes/_protected.*",
  "@/routes/_protected.*/**",
];

const webCrossWorkspaceImports = [
  {
    group: ["@stll/api", "@stll/api/**", "!@stll/api/eden-contract"],
    message: "apps/web may only import the counted API Eden contract surface.",
  },
  {
    group: [
      "@stll/desktop",
      "@stll/desktop/**",
      "@stll/landing",
      "@stll/landing/**",
    ],
    message: "apps/web must not import other app workspaces directly.",
  },
];

// The design system is published from its own source: it has to build,
// test, and typecheck with nothing but its declared dependencies present.
// Bans reaching sideways into an application, into a private workspace
// package, and back into itself through the package name (the intra-package
// graph is relative, so a self-reference would only survive in-repo).
const uiStandaloneImports = [
  {
    group: ["@stll/*", "@stll/*/**"],
    message:
      "@stll/ui must build standalone; it may not import another workspace package, including itself by name.",
  },
  {
    group: ["@/*", "@/**", "apps/*", "apps/**", "**/apps/**"],
    message:
      "@stll/ui must not reach into application code; move the shared part into the package or keep the component in the app.",
  },
];

const webDatePickerImport = {
  // Both spellings: the grouped subpath is a deprecated alias of the flat one
  // and still resolves, so banning only the flat one would leave a way around.
  group: [
    "@stll/ui/date-picker-popover",
    "@stll/ui/components/date-picker-popover",
  ],
  message:
    "Use '@/components/date-picker-popover' so locale labels are injected.",
};

const apiSafeIdBrandingImport = {
  name: "@/api/lib/branded-types",
  importNames: ["toSafeId"],
  message:
    "Only approved boundary modules and tests may brand raw IDs with toSafeId.",
};

// The portable contract helper brands any string for any id kind, so reaching
// it directly would route around both the sanctioned boundaries above and the
// SafeIdType union. apps/web re-exports it once; apps/api never imports it.
const apiPortableSafeIdBrandingImport = {
  name: "@stll/api-contract/safe-id",
  importNames: ["toSafeId"],
  message:
    "Brand ids through '@/api/lib/safe-id-boundaries', not the portable contract helper.",
};

// pragmatic-drag-and-drop's element adapter keeps exactly one live drop
// target, and one draggable, per element behind a private WeakMap registry:
// a second direct `dropTargetForElements`/`draggable` call on a node it is
// already watching silently replaces the first, with no error anywhere.
// That is exactly how a flat-column kanban card target once went dark, so
// each surface that plugs into the adapter funnels registration through one
// owner that can detect a same-element conflict instead of calling the
// adapter directly. `monitorForElements` (no per-element registry) is not
// restricted.
const webPragmaticDragAdapterImport = {
  name: "@atlaskit/pragmatic-drag-and-drop/element/adapter",
  importNames: ["draggable", "dropTargetForElements"],
  message:
    "Register kanban element drag sources and drop targets through use-kanban-drop-targets.ts's attachElementDropTarget/draggable, not directly: pragmatic-drag-and-drop keeps only one live drop target per element, so a second direct registration silently replaces the first.",
};

const uiPragmaticDragAdapterImport = {
  name: "@atlaskit/pragmatic-drag-and-drop/element/adapter",
  importNames: ["draggable", "dropTargetForElements"],
  message:
    "Register kanban element drag sources and drop targets through kanban/drag-interactions.ts, not directly: pragmatic-drag-and-drop keeps only one live drop target per element, so a second direct registration silently replaces the first.",
};

// The adapter is a single published entry point with no public subpaths;
// nothing should import a level deeper than the module the two bans above
// already cover.
const pragmaticDragAdapterDeepImportBan = {
  group: ["@atlaskit/pragmatic-drag-and-drop/element/adapter/*"],
  message:
    "Import only '@atlaskit/pragmatic-drag-and-drop/element/adapter'; it has no public subpaths.",
};

// Oxlint 1.80 split the monolithic react/react-compiler rule into categories.
// These are one logical ruleset: spreads preserve the former whole-compiler
// exemption only where the compiler cannot meaningfully analyze the source.
const reactCompilerRulesOff = {
  "react/capitalized-calls": "off",
  "react/error-boundaries": "off",
  "react/exhaustive-effect-dependencies": "off",
  "react/globals": "off",
  "react/hooks": "off",
  "react/immutability": "off",
  "react/incompatible-library": "off",
  "react/invariant": "off",
  "react/memo-dependencies": "off",
  "react/no-deriving-state-in-effects": "off",
  "react/preserve-manual-memoization": "off",
  "react/purity": "off",
  "react/refs": "off",
  "react/rule-suppression": "off",
  "react/set-state-in-effect": "off",
  "react/set-state-in-render": "off",
  "react/static-components": "off",
  "react/syntax": "off",
  "react/todo": "off",
  "react/unsupported-syntax": "off",
  "react/use-memo": "off",
  "react/void-use-memo": "off",
} satisfies NonNullable<OxlintOverride["rules"]>;

// oxlint-tailwindcss validates generated utilities. These classes are owned by
// component CSS or inline <style> blocks instead, so list each spelling rather
// than exempting broad prefixes that could hide a Tailwind typo.
const customCssClassNames = [
  "animate-flow-in",
  "animate-slide-in",
  "auth-gradient",
  "catalogue-row-in",
  "chat-editor",
  "clause-directive",
  "clause-editor",
  "cli-client",
  "cli-command",
  "cli-command-character",
  "cli-cursor",
  "cli-discover-tag",
  "cli-idle-prompt",
  "cli-main-window",
  "cli-response",
  "cli-result",
  "cli-selected",
  "cli-story",
  "cli-story-auto",
  "cli-story-reflection",
  "cli-story-scene-only",
  "cli-story-transparent",
  "cli-story-two-window",
  "cli-story-wash",
  "cli-story-with-scroll-reveal",
  "cli-summary",
  "cli-window",
  "cwp-draw",
  "cwp-pop",
  "cwp-press",
  "cwp-rise",
  "document-preview-surface",
  "draft-line",
  "entity-span",
  "error-gradient",
  "folio-ai-bar-editor",
  "folio-ai-bar-editor--custom-placeholder",
  "folio-ai-host",
  "folio-docx-preview",
  "folio-peek",
  "fixture-board",
  "is-assistant",
  "is-system",
  "is-user",
  "kanban-test-list",
  "line",
  "mac-titlebar",
  "mac-traffic-glyph",
  "mac-traffic-light",
  "mac-traffic-minus",
  "mac-window",
  "markdown-hybrid-editor",
  "ray",
  "reader-apparatus",
  "reader-apparatus-summary",
  "reader-justify",
  "reader-note-back",
  "reader-note-label",
  "reader-note-ref",
  "reader-page-marker",
  "reader-page-tick",
  "reader-paper",
  "reader-scroll",
  "reader-signature",
  "reader-statute",
  "research-burst",
  "review-line",
  "scan",
  "search-document-highlight",
  "showcase-description",
  "showcase-grid",
  "showcase-tile",
  "showcase-title",
  "stella-office-spreadsheet",
  "story-step",
  "story-step-visible",
  "view-layout-preview-fade-in",
  "view-layout-preview-fade-out",
  "view-layout-preview-move",
  "word",
] satisfies string[];

export default defineConfig({
  extends: [core, react],
  settings: {
    tailwindcss: {
      entryPoint: [
        { files: "apps/web/**", use: "apps/web/src/styles/app.css" },
        {
          files: "apps/desktop/**",
          use: "apps/desktop/src/mainview/index.css",
        },
        {
          files: "apps/playground/**",
          use: "apps/playground/src/styles.css",
        },
        {
          files: "apps/landing/**",
          use: "apps/landing/src/styles/global.css",
        },
        // Shared packages use the web entry point as the canonical complete
        // @stll/ui theme. Consumer-specific entry points are intentionally
        // checked above before this shared fallback.
        { files: "packages/ui/**", use: "apps/web/src/styles/app.css" },
        { files: "packages/chat/**", use: "apps/web/src/styles/app.css" },
        {
          files: "packages/workspace-ui/**",
          use: "apps/web/src/styles/app.css",
        },
      ],
      // `style` and `styles` commonly hold CSSProperties or unrelated values;
      // Tailwind classes remain covered in JSX attributes and cn/cva calls.
      exclude: { variablePatterns: ["^styles?$"] },
    },
  },
  rules: {
    ...libraryRules,
    // Override ultracite defaults for Stella
    // The generic rule fires on every sequential await, including the ones a
    // stream, a cursor, a rate limit, or an ordered write requires; it was
    // waived far more often than it was obeyed. The cost it exists to catch
    // is per-iteration I/O, which `no-db-await-in-loop` and
    // `no-network-await-in-loop` flag with the owner in hand.
    "no-await-in-loop": "off",
    "no-console": "error",
    "no-shadow": "error",
    "no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        ignoreRestSiblings: true,
        varsIgnorePattern: "^_",
      },
    ],
    // The TypeScript extension below recognizes returned thenables. Retain
    // the base rule only for JavaScript through the override below.
    "require-await": "off",
    "no-useless-catch": "error",
    "no-non-null-assertion": "error",

    "typescript/no-explicit-any": "error",
    "typescript/no-dynamic-delete": "error",
    "typescript/require-await": "error",
    "typescript/no-misused-promises": [
      "error",
      { checksVoidReturn: { attributes: false } },
    ],
    "typescript/consistent-type-definitions": ["error", "type"],

    "unicorn/no-useless-undefined": "off",
    "unicorn/prefer-array-find": "error",
    "unicorn/prefer-at": "error",
    "unicorn/prefer-node-protocol": "error",
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
    // Ultracite configures only named components as arrows, leaving Oxlint's
    // function-expression default for memo callbacks in conflict with
    // `prefer-arrow-callback`. Use one total component style.
    "react/function-component-definition": [
      "error",
      {
        namedComponents: "arrow-function",
        unnamedComponents: "arrow-function",
      },
    ],
    "react/style-prop-object": "error",
    "react/jsx-no-comment-textnodes": "error",
    "react/iframe-missing-sandbox": "error",
    "react/jsx-no-target-blank": "error",
    "react/jsx-no-script-url": "error",
    "react/button-has-type": "error",
    "react/checked-requires-onchange-or-readonly": "error",
    "react/no-unknown-property": "error",
    "react/no-object-type-as-default-prop": "error",
    // Allow component creation in prop position: i18n rich-text render
    // callbacks (`t.rich({ link: (chunks) => <a/> })`) and IIFE-as-prop
    // element builders are idiomatic here and are not remounted components.
    "react/no-unstable-nested-components": ["error", { allowAsProps: true }],
    // Off: the Result.gen handler generators (`async function*` with
    // `yield* Result.await(...)`) have no meaningful user-facing yield type
    // to document, and the codebase's JSDoc style uses bare tags.
    "jsdoc/require-yields-type": "off",
    "promise/always-return": "error",
    "promise/no-return-in-finally": "error",
    "no-useless-assignment": "error",

    // Keep `import/no-cycle`: current web profiling puts it below 1% of rule
    // time. The Module Side Effects section in CLAUDE.md documents the TDZ class
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
    "no-restricted-imports": ["error", { paths: [noZodImport] }],
    "no-bare-error/no-bare-error": "error",
    "no-minted-auth-provider-id/no-minted-auth-provider-id": "error",
    "ai-output-strict-schema/ai-output-strict-schema": "error",
    "require-complete-compaction-generation/require-complete-compaction-generation":
      "error",
    "no-coerced-optional-union-enum/no-coerced-optional-union-enum": "error",
    "tagged-error-requires-message/tagged-error-requires-message": "error",
    "require-custom-jsonb-column/require-custom-jsonb-column": "error",
    // The column-cast allowlist lives in per-file overrides below, scoped to
    // the files that own the schema objects, so the same spelling elsewhere
    // stays flagged.
    "no-bare-jsonb-cast/no-bare-jsonb-cast": "error",
    "no-hand-rolled-sql-case/no-hand-rolled-sql-case": "error",
    "require-timestamptz-column/require-timestamptz-column": "error",
    "no-naive-timestamp-cast/no-naive-timestamp-cast": "error",
    "no-inline-timestamp-cursor-sql/no-inline-timestamp-cursor-sql": "error",
    "require-timestamp-id-cursor-codec/require-timestamp-id-cursor-codec":
      "error",
    "no-direct-audit-log-insert/no-direct-audit-log-insert": "error",
    "no-direct-property-table-write/no-direct-property-table-write": "error",
    "no-direct-template-version-write/no-direct-template-version-write":
      "error",
    "no-condition-combinator-outside-conditions/no-condition-combinator-outside-conditions":
      "error",
    "no-direct-buffer-cleanup-intent-delete/no-direct-buffer-cleanup-intent-delete":
      "error",
    "require-buffer-cleanup-intent-status/require-buffer-cleanup-intent-status":
      "error",
    // Cursor query fields come from `tPaginationCursor()`, which owns the byte
    // cap and the description an MCP client reads. The BOE search cursor is
    // not that: it is an upstream page number, validated by its own syntax
    // pattern and capped at five characters.
    "require-pagination-cursor-schema/require-pagination-cursor-schema": [
      "error",
      {
        allowedFiles: ["apps/api/src/handlers/legislation/boe-search.ts"],
      },
    ],
    // Anchored on the timestamp column, so the operand is always required
    // to carry the safe form; helpers that emit their own cast are named in
    // `allowedOperandCalls` rather than inferred from shape.
    "no-truncated-timestamp-comparison/no-truncated-timestamp-comparison": [
      "error",
      {
        allowedOperandCalls: [
          "pgTimestampCursorBoundary",
          "pgTimestampCursorValue",
          "timestampCasToken",
          "databaseNow",
        ],
      },
    ],
    "no-spread-input-in-query-key/no-spread-input-in-query-key": "error",
    "no-facade-imports/no-facade-imports": "error",
    "docs-source-policy/docs-source-policy": "error",
    "no-unsafe-inner-html/no-unsafe-inner-html": "error",
    "no-static-devtools-import/no-static-devtools-import": "error",
    "no-static-catalogue-route-import/no-static-catalogue-route-import": [
      "error",
      {
        routeFiles: ["apps/web/src/routes/_protected.knowledge/tools.tsx"],
      },
    ],
    "suppression-hygiene/require-description": "error",
    "suppression-hygiene/no-foreign-directive": "error",
    "typescript/ban-ts-comment": [
      "error",
      {
        "ts-expect-error": "allow-with-description",
        "ts-ignore": true,
        "ts-nocheck": false,
        "ts-check": false,
        minimumDescriptionLength: 3,
      },
    ],
    "no-nanoid/no-nanoid": "error",
    "no-direct-matter-glyph/no-direct-matter-glyph": "error",
    "no-direct-entity-glyph/no-direct-entity-glyph": "error",
    "no-raw-user-avatar-primitive/no-raw-user-avatar-primitive": "error",
    "no-shadowed-user-name-helpers/no-shadowed-user-name-helpers": "error",
    "no-hand-rolled-user-identity/no-hand-rolled-user-identity": "error",
    "no-unpaired-playbook-verdict/no-unpaired-playbook-verdict": "error",
    "require-relative-time-helpers/require-relative-time-helpers": "error",
    "no-raw-date-input/no-raw-date-input": "error",
    "stella-lowercase/stella-lowercase": "error",
    "no-unvalidated-json-domain-cast/no-unvalidated-json-domain-cast": "error",
    "no-unjustified-double-assertion/no-unjustified-double-assertion": "error",
    "no-partial-record-satisfies/no-partial-record-satisfies": "error",
    "no-raw-public-law-seo/no-raw-public-law-seo": "off",
    "public-case-law-db-boundary/public-case-law-db-boundary": "off",
    "public-law-read-boundary/require-language-alternate-counts": "off",
    "public-law-read-boundary/require-configured-read-transaction": "off",
    "require-contained-handler/no-portal-under-interactive-ancestor": "error",
    "require-contained-handler/require-contained-handler": "error",
    "require-function-replacer/require-function-replacer": "error",
    "no-void": ["error", { allowAsStatement: true }],

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
    "no-unmodified-loop-condition": "error",
    "no-loop-func": "error",
    complexity: ["error", 50],
    "func-style": "off",
    "func-names": "off",

    "typescript/no-inferrable-types": "off",
    "typescript/consistent-return": "error",
    "typescript/dot-notation": "error",
    "typescript/prefer-readonly": "error",
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

    // A `default:` clause must not hide an unhandled member of a closed union.
    // Catch-all parsers over genuinely open upstream strings should narrow the
    // known domain first or carry a scoped suppression explaining that the
    // default represents an explicit unknown-upstream disposition.
    "typescript/switch-exhaustiveness-check": [
      "error",
      { considerDefaultExhaustiveForUnions: false },
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
    // Disabled: the legitimate "throw Error() needs new" case is already
    // covered (more strictly) by the custom no-bare-error rule, and oxlint
    // 1.70+ broadened this rule to flag error-named factory calls in a class
    // `extends` clause — a false positive on the better-result
    // `TaggedError("X")<{...}>()` pattern used throughout the codebase.
    "unicorn/throw-new-error": "off",
    "unicorn/no-array-reduce": "error",
    "unicorn/no-array-sort": "off",
    "unicorn/no-useless-spread": "off",
    // NOT enabled: unicorn/prefer-number-coercion. Its parseInt(x, 10) ->
    // Number(x) transform is not semantics-preserving (lenient prefix parsing,
    // "" handling, hex strings); ingestion adapters rely on parseInt behavior.
    "unicorn/no-await-expression-member": "off",
    // Candidate strict rule, not enabled yet: overlaps with no-nested-ternary.
    "unicorn/no-nested-ternary": "off",
    "unicorn/prefer-set-has": "error",
    "unicorn/prefer-spread": "off",

    "react_perf/jsx-no-new-function-as-prop": "off",

    "react/hook-use-state": "off",
    // These categories report React Compiler implementation limits and internal
    // invariants. The former monolithic rule filtered them unless
    // reportAllBailouts was enabled; keep that behavior while actionable
    // categories remain enabled by Ultracite.
    "react/invariant": "off",
    "react/todo": "off",
    // `react/jsx-key` and `react/no-array-index-key` are enabled ("error") for
    // apps/web/src and packages/workspace-ui/src via the overrides below. The
    // other React surfaces (folio, ui, desktop, landing, playground) are not
    // swept yet, and `react/hook-use-state` above is off everywhere.
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
    // The rule is still nursery; restrict it to actual nullish operands so
    // replacing a truthiness check cannot change 0/false/empty-string behavior.
    "typescript/prefer-optional-chain": ["error", { requireNullish: true }],
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

    // Ultracite 7.9.3 removed its slow JS-plugin rules from the default
    // presets. These native-rule exceptions remain Stella-specific.
    "unicorn/prefer-export-from": "off",
    "unicorn/prefer-number-coercion": "off",
    "unicorn/prefer-single-call": "off",
    "prefer-named-capture-group": "off",
    "react/jsx-curly-brace-presence": "off",
    "react/no-unescaped-entities": "off",
    // Fires on any method named setState; no class components exist here.
    "react/no-set-state": "off",
    "react/display-name": "off",

    // React Compiler memoizes context values in apps/web; the remaining
    // hits are genuinely reactive values with no static part to hoist.
    "react/jsx-no-constructed-context-values": "off",
  },
  ignorePatterns: [
    ...libraryIgnorePatterns,
    "**/routeTree.gen.ts",
    "**/*.config.js",
    // Module-augmentation files must use `interface` for declaration
    // merging; oxlint's --fix would rewrite it to `type` and break it.
    "types/**/*.d.ts",
    // Static browser assets (e.g. the CSP-strict dark-mode bootstrap) are
    // untyped JS; type-aware rules flag their DOM globals as `error`.
    "apps/web/public/**",
    // Declaration files carry no runtime code; skip product-code rules.
    "**/*.d.ts",
    // Snowball stemmers: generated output plus the upstream JS runtime,
    // transcribed verbatim. Product-code rules would rewrite the algorithm
    // (prefer-code-point changes UTF-16 semantics; no-bitwise has no
    // equivalent for the grouping bitsets) and every --fix would be undone
    // by the next regeneration. Bound instead by the conformance fixtures
    // in snowball/__fixtures__ and by
    // scripts/generate-snowball-stemmers.ts.
    "apps/api/src/lib/legal-search/morphology/snowball/*.gen.ts",
    "apps/api/src/lib/legal-search/morphology/snowball/base-stemmer.ts",
    // The template-pack content repository is a submodule with its own
    // toolchain and lint setup; this repo neither authors nor formats it.
    "packages/template-packs/content/**",
    // Template-pack manifests: generated verbatim from the content
    // repository, down to author names and descriptions. Prose rules would
    // rewrite quoted upstream text, and every --fix would be undone by the
    // next regeneration. Bound instead by scripts/generate-manifest.ts
    // --check and the per-template content hashes.
    "packages/template-packs/src/**/packs.gen.ts",
  ],

  jsPlugins: [
    stellaLowercasePluginSpecifier,
    "@tanstack/eslint-plugin-query",
    "@tanstack/eslint-plugin-router",
    "eslint-plugin-drizzle",
    "oxlint-tailwindcss",
    "@stll/oxlint-config/no-raw-colors",
    "./.oxlint-plugins/no-raw-date-input.ts",
    "./.oxlint-plugins/no-raw-date-parsing.ts",
    "./.oxlint-plugins/no-raw-locale-format.ts",
    "./.oxlint-plugins/no-input-dir-auto.ts",
    "./.oxlint-plugins/require-dir-on-rendered-name.ts",
    "./.oxlint-plugins/no-unformatted-number.ts",
    "./.oxlint-plugins/no-literal-minor-unit-scale.ts",
    "./.oxlint-plugins/no-raw-foreground-opacity.ts",
    "./.oxlint-plugins/no-inline-style-colors.ts",
    "./.oxlint-plugins/no-ambient-hotkey-format.ts",
    "./.oxlint-plugins/no-ambient-nondeterminism.ts",
    "./.oxlint-plugins/no-physical-properties.ts",
    "./.oxlint-plugins/no-body-ownership-ids.ts",
    "./.oxlint-plugins/no-raw-error-logging.ts",
    "./.oxlint-plugins/no-redacted-log-attribute-key.ts",
    "./.oxlint-plugins/no-untyped-updates.ts",
    "./.oxlint-plugins/no-nanoid.ts",
    "./.oxlint-plugins/no-direct-matter-glyph.ts",
    "./.oxlint-plugins/no-direct-entity-glyph.ts",
    "./.oxlint-plugins/no-raw-user-avatar-primitive.ts",
    "./.oxlint-plugins/no-shadowed-user-name-helpers.ts",
    "./.oxlint-plugins/no-hand-rolled-user-identity.ts",
    "./.oxlint-plugins/no-unpaired-playbook-verdict.ts",
    "./.oxlint-plugins/require-relative-time-helpers.ts",
    "./.oxlint-plugins/no-crypto-random-uuid.ts",
    "./.oxlint-plugins/no-native-s3-object-read.ts",
    "./.oxlint-plugins/no-native-s3-object-write.ts",
    "./.oxlint-plugins/no-raw-use-effect.ts",
    "./.oxlint-plugins/require-cn-for-classname-composition.ts",
    "./.oxlint-plugins/no-ref-mirror.ts",
    "./.oxlint-plugins/no-adhoc-loader.ts",
    "./.oxlint-plugins/no-shared-suspense-query.ts",
    "./.oxlint-plugins/no-bare-chrome-query.ts",
    "./.oxlint-plugins/no-strict-route-read-in-chrome.ts",
    "./.oxlint-plugins/require-router-select.ts",
    "./.oxlint-plugins/require-loader-prefetch.ts",
    "./.oxlint-plugins/require-matter-affordance.ts",
    "./.oxlint-plugins/no-raw-route-query-client.ts",
    "./.oxlint-plugins/no-raw-router-invalidation.ts",
    "./.oxlint-plugins/no-optional-mutation-command.ts",
    "./.oxlint-plugins/no-beforeload-redirect.ts",
    "./.oxlint-plugins/require-safe-route-handlers.ts",
    "./.oxlint-plugins/no-inline-endpoint-in-routes.ts",
    "./.oxlint-plugins/security-guards.ts",
    "./.oxlint-plugins/no-unbranded-ownership-id-param.ts",
    "./.oxlint-plugins/no-unjustified-double-assertion.ts",
    "./.oxlint-plugins/no-raw-user-id-schema.ts",
    "./.oxlint-plugins/no-offset-pagination.ts",
    "./.oxlint-plugins/require-query-limit.ts",
    "./.oxlint-plugins/require-search-scope.ts",
    "./.oxlint-plugins/no-direct-ingestion-checkpoint-write.ts",
    "./.oxlint-plugins/no-unowned-file-version-write.ts",
    "./.oxlint-plugins/mcp-security.ts",
    "./.oxlint-plugins/auth-lifecycle.ts",
    "./.oxlint-plugins/stella-toast.ts",
    "./.oxlint-plugins/no-untranslated-jsx-literal.ts",
    "./.oxlint-plugins/forbid-process-env-outside-env-ts.ts",
    "./.oxlint-plugins/forbid-dev-runner-config-reads.ts",
    "./.oxlint-plugins/docs-source-policy.ts",
    "./.oxlint-plugins/no-facade-imports.ts",
    "./.oxlint-plugins/no-secret-in-log-sink.ts",
    "./.oxlint-plugins/no-raw-api-url.ts",
    "./.oxlint-plugins/no-raw-resource-uri.ts",
    "./.oxlint-plugins/no-legacy-entity-route.ts",
    "./.oxlint-plugins/require-eden-error-check.ts",
    "./.oxlint-plugins/require-function-replacer.ts",
    "./.oxlint-plugins/require-fetch-timeout.ts",
    "./.oxlint-plugins/require-file-transport-disposition.ts",
    "./.oxlint-plugins/require-escape-like.ts",
    "./.oxlint-plugins/no-bare-error.ts",
    "./.oxlint-plugins/no-minted-auth-provider-id.ts",
    "./.oxlint-plugins/ai-output-strict-schema.ts",
    "./.oxlint-plugins/require-complete-compaction-generation.ts",
    "./.oxlint-plugins/require-audit-on-mutation.ts",
    "./.oxlint-plugins/require-transaction-abort.ts",
    "./.oxlint-plugins/no-direct-audit-log-insert.ts",
    "./.oxlint-plugins/no-direct-property-table-write.ts",
    "./.oxlint-plugins/no-direct-template-version-write.ts",
    "./.oxlint-plugins/no-condition-combinator-outside-conditions.ts",
    "./.oxlint-plugins/no-direct-buffer-cleanup-intent-delete.ts",
    "./.oxlint-plugins/require-buffer-cleanup-intent-status.ts",
    "./.oxlint-plugins/no-unvalidated-json-domain-cast.ts",
    "./.oxlint-plugins/no-raw-public-law-seo.ts",
    "./.oxlint-plugins/public-case-law-db-boundary.ts",
    "./.oxlint-plugins/public-law-read-boundary.ts",
    "./.oxlint-plugins/require-contained-handler.ts",
    "./.oxlint-plugins/suppression-hygiene.ts",
    "./.oxlint-plugins/no-coerced-optional-union-enum.ts",
    "./.oxlint-plugins/tagged-error-requires-message.ts",
    "./.oxlint-plugins/require-custom-jsonb-column.ts",
    "./.oxlint-plugins/no-bare-jsonb-cast.ts",
    "./.oxlint-plugins/no-hand-rolled-sql-case.ts",
    "./.oxlint-plugins/require-derived-check-enum.ts",
    "./.oxlint-plugins/require-timestamptz-column.ts",
    "./.oxlint-plugins/no-naive-timestamp-cast.ts",
    "./.oxlint-plugins/no-inline-timestamp-cursor-sql.ts",
    "./.oxlint-plugins/require-timestamp-id-cursor-codec.ts",
    "./.oxlint-plugins/require-pagination-cursor-schema.ts",
    "./.oxlint-plugins/no-truncated-timestamp-comparison.ts",
    "./.oxlint-plugins/no-spread-input-in-query-key.ts",
    "./.oxlint-plugins/require-query-key-factory.ts",
    "./.oxlint-plugins/no-unsafe-inner-html.ts",
    "./.oxlint-plugins/no-vacuous-throw-assertion.ts",
    "./.oxlint-plugins/no-internal-module-mock.ts",
    "./.oxlint-plugins/no-centered-scroll-column.ts",
    "./.oxlint-plugins/no-static-devtools-import.ts",
    "./.oxlint-plugins/no-static-catalogue-route-import.ts",
    "./.oxlint-plugins/no-workspace-field-value-drift.ts",
    "./.oxlint-plugins/icon-button-requires-tooltip.ts",
    "./.oxlint-plugins/no-disabled-tooltip-trigger.ts",
    "./.oxlint-plugins/no-dialog-trigger-menu-item.ts",
    "./.oxlint-plugins/no-document-cookie.ts",
    "./.oxlint-plugins/require-safe-window-open.ts",
    "./.oxlint-plugins/require-safe-outbound-target.ts",
    "./.oxlint-plugins/no-object-url-leak.ts",
    "./.oxlint-plugins/require-stream-reader-disposal.ts",
    "./.oxlint-plugins/no-auth-token-in-web-storage.ts",
    "./.oxlint-plugins/no-path-prefix-containment.ts",
    "./.oxlint-plugins/no-eager-singleton.ts",
    "./.oxlint-plugins/no-db-await-in-loop.ts",
    "./.oxlint-plugins/no-network-await-in-loop.ts",
    "./.oxlint-plugins/require-cached-collator.ts",
    "./.oxlint-plugins/require-query-signal.ts",
    "./.oxlint-plugins/require-stable-snapshot.ts",
    "./.oxlint-plugins/require-stable-editor-options.ts",
    "./.oxlint-plugins/require-use-shallow.ts",
    "./.oxlint-plugins/no-raw-stored-json.ts",
    "./.oxlint-plugins/no-detached-void.ts",
    "./.oxlint-plugins/no-broad-translation-callable.ts",
    "./.oxlint-plugins/no-partial-record-satisfies.ts",
    "./.oxlint-plugins/require-toast-error-capture.ts",
    "./.oxlint-plugins/no-swallowed-rejection.ts",
    "./.oxlint-plugins/require-detached-label-shape.ts",
    "./.oxlint-plugins/no-awaited-builder-union.ts",
    "./.oxlint-plugins/confine-owner.ts",
    "./.oxlint-plugins/queue-worker-error-sink.ts",
    "./.oxlint-plugins/require-coordination-key.ts",
    "./.oxlint-plugins/no-async-context-enter-with.ts",
    "./.oxlint-plugins/no-omitted-prop-respread.ts",
    "./.oxlint-plugins/no-throw-outside-boundary.ts",
    "./.oxlint-plugins/require-exhaustive-panic.ts",
    "./.oxlint-plugins/no-try-catch-outside-boundary.ts",
  ],

  overrides: [
    ...(core.overrides ?? []),
    ...libraryOverrides,
    {
      files: [
        "apps/web/**/*.{js,jsx,ts,tsx}",
        "apps/desktop/src/**/*.{js,jsx,ts,tsx}",
        "apps/playground/src/**/*.{js,jsx,ts,tsx}",
        "apps/landing/src/**/*.{js,jsx,ts,tsx}",
        "packages/ui/src/**/*.{js,jsx,ts,tsx}",
        "packages/chat/src/**/*.{js,jsx,ts,tsx}",
        "packages/workspace-ui/src/**/*.{js,jsx,ts,tsx}",
      ],
      rules: {
        "tailwindcss/no-conflicting-classes": [
          "error",
          {
            // Revealing an sr-only control resets it to static positioning;
            // these keyboard-focus variants deliberately reposition it.
            allow: [
              [
                "^(?:focus|focus-visible):not-sr-only$",
                "^(?:focus|focus-visible):(absolute|w-max|border)$",
              ],
            ],
          },
        ],
        "tailwindcss/no-deprecated-classes": "error",
        "tailwindcss/no-duplicate-classes": "error",
        "tailwindcss/no-unknown-classes": [
          "error",
          { allowlist: customCssClassNames },
        ],
      },
    },
    {
      // Oxlint 1.80 split React Compiler diagnostics into independently
      // configurable categories. These files are the dependency-analysis
      // backlog first exposed by that split; exact paths keep new code and
      // new files checked while the legacy cases are repaired individually.
      files: [
        "apps/desktop/src/clipboard/ClipboardApp.tsx",
        "apps/landing/src/components/react/AnonymizeLiveDemo.tsx",
        "apps/landing/src/components/react/EditorLiveDemo.tsx",
        "apps/landing/src/components/react/previews/CliMcpPreview.tsx",
        "apps/web/src/components/ai-suggestions/file-chat-overlay.tsx",
        "apps/web/src/components/chat/chat-thread-messages.tsx",
        "apps/web/src/components/chat-editor-provider.tsx",
        "apps/web/src/components/inspector/anonymization-facet.tsx",
        "apps/web/src/components/inspector/inspector-panel.tsx",
        "apps/web/src/routes/_protected.knowledge/-components/template-studio-chat.tsx",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-view.tsx",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/cell-metadata-flags.tsx",
        "packages/ui/src/components/hex-color-picker.tsx",
      ],
      rules: {
        "react/exhaustive-effect-dependencies": "off",
      },
    },
    {
      // These APIs intentionally return unstable functions. Preserve the
      // compiler's existing bailout for the current call sites, but keep the
      // category enabled everywhere else so the list can only shrink.
      files: [
        "apps/web/src/components/bilingual-review-rows.tsx",
        "apps/web/src/components/search-dialog.tsx",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view.tsx",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-column.tsx",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/index.tsx",
        "packages/ui/src/kanban/virtual-cell.tsx",
      ],
      rules: {
        "react/incompatible-library": "off",
      },
    },
    {
      // TanStack route objects are initialized before their components, while
      // those components read the exported Route object. Function declarations
      // preserve that intentional two-way declaration order without a TDZ. The
      // route slice also owns colocated components, so allow its existing mixed
      // style rather than imposing the incompatible global arrow-only policy.
      files: ["apps/web/src/routes/**/*.{ts,tsx}"],
      rules: {
        "react/function-component-definition": "off",
      },
    },
    {
      files: ["**/*.{js,jsx,mjs,cjs}"],
      rules: {
        "require-await": "error",
        "typescript/require-await": "off",
      },
    },
    {
      // Custom oxlint plugin rules traverse AST nodes that the runtime
      // delivers as untyped (effectively `any`). Strict any-flow rules
      // produce noise without real safety here.
      files: [".oxlint-plugins/**/*.{ts,tsx}"],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/strict-boolean-expressions": "off",
        "require-unicode-regexp": "off",
        "no-nested-ternary": "off",
        // Regression fixtures deliberately embed ref-during-render and
        // stale-closure patterns to exercise the custom plugin rules; they
        // are not product code, so React Compiler noise stays off here.
        ...reactCompilerRulesOff,
        // Plugin sources and fixtures embed directive strings as
        // documentation/regression examples; do not lint them as real
        // directives.
        "suppression-hygiene/require-description": "off",
        "suppression-hygiene/no-foreign-directive": "off",
      },
    },
    {
      // This fixture intentionally passes unbound and value-returning ambient
      // functions through callback positions. Those TypeScript diagnostics
      // vary with Oxlint's target set, while the custom-rule directives are
      // the mutation proof this fixture owns.
      files: [
        ".oxlint-plugins/__fixtures__/no-ambient-nondeterminism.fixture.ts",
      ],
      rules: {
        "typescript/no-implied-eval": "off",
        "typescript/strict-void-return": "off",
        "typescript/unbound-method": "off",
      },
    },
    {
      // The only interpolations that legitimately take a bare `::jsonb`: each
      // casts a text column, not a bind parameter. Named rather than inferred
      // from shape (`payload.astJson` is a member expression too and is a
      // serialized value), and scoped to the file that owns the schema object
      // so the same spelling elsewhere stays flagged.
      files: ["apps/api/src/db/auth-schema.ts"],
      rules: {
        "no-bare-jsonb-cast/no-bare-jsonb-cast": [
          "error",
          { allowedColumnExpressions: ["table.metadata"] },
        ],
      },
    },
    {
      files: ["apps/api/src/lib/machine-api-key-scope.ts"],
      rules: {
        "no-bare-jsonb-cast/no-bare-jsonb-cast": [
          "error",
          { allowedColumnExpressions: ["apikey.metadata"] },
        ],
      },
    },
    {
      // no-naive-timestamp-cast's fixture builds truncating comparisons on
      // purpose (`created_at > ${cursor}::timestamp`) to exercise that rule's
      // cast detection. They are examples, not call sites, so the comparison
      // guard is off there rather than layering a second disable directive on
      // every line.
      files: [
        ".oxlint-plugins/__fixtures__/no-naive-timestamp-cast.fixture.ts",
      ],
      rules: {
        "no-truncated-timestamp-comparison/no-truncated-timestamp-comparison":
          "off",
      },
    },
    {
      // Exercise the allowed-column case (`_columnCast`) in the fixture.
      files: [".oxlint-plugins/__fixtures__/no-bare-jsonb-cast.fixture.ts"],
      rules: {
        "no-bare-jsonb-cast/no-bare-jsonb-cast": [
          "error",
          { allowedColumnExpressions: ["table.metadata"] },
        ],
      },
    },
    {
      // Exercise no-native-s3-object-read against its regression fixture; the
      // rule is otherwise scoped to apps/api, which the fixtures dir is not.
      files: [
        ".oxlint-plugins/__fixtures__/no-native-s3-object-read.fixture.ts",
      ],
      rules: {
        "no-native-s3-object-read/no-native-s3-object-read": "error",
      },
    },
    {
      // Exercise no-native-s3-object-write against its regression fixture;
      // production enforcement is scoped to apps/api below.
      files: [
        ".oxlint-plugins/__fixtures__/no-native-s3-object-write.fixture.ts",
      ],
      rules: {
        "no-native-s3-object-write/no-native-s3-object-write": "error",
      },
    },
    {
      // Exercise no-raw-use-effect against its regression fixture; the rule is
      // otherwise scoped to apps/web/src, which the fixtures dir is not.
      files: [".oxlint-plugins/__fixtures__/no-raw-use-effect.fixture.tsx"],
      rules: { "no-raw-use-effect/no-raw-use-effect": "error" },
    },
    {
      // Exercise require-query-signal against its regression fixture; the
      // rule is otherwise scoped to apps/web/src, which the fixtures dir is
      // not.
      files: [".oxlint-plugins/__fixtures__/require-query-signal.fixture.ts"],
      rules: { "require-query-signal/require-query-signal": "error" },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/no-raw-route-query-client.fixture.tsx",
      ],
      rules: {
        "no-raw-route-query-client/no-raw-route-query-client": "error",
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/no-beforeload-redirect.fixture.tsx",
      ],
      rules: {
        "no-beforeload-redirect/no-beforeload-redirect": "error",
      },
    },
    {
      files: [".oxlint-plugins/__fixtures__/no-ref-mirror.fixture.tsx"],
      rules: { "no-ref-mirror/no-ref-mirror": "error" },
    },
    {
      files: [
        "apps/web/src/**/*.tsx",
        "apps/desktop/src/**/*.tsx",
        "apps/landing/src/**/*.tsx",
        "packages/ui/src/**/*.tsx",
        "packages/workspace-ui/src/**/*.tsx",
      ],
      rules: {
        "no-adhoc-loader/no-adhoc-loader": [
          "error",
          {
            // Sites that predate `@stll/ui/loader`. A ratchet: entries can
            // only be removed as each site moves to `Loader`/`Skeleton`, and
            // no new file may add itself.
            allowedFiles: [
              "apps/web/src/components/ai-rewrite-control.tsx",
              "apps/web/src/components/ai-suggestions/file-chat-overlay.tsx",
              "apps/web/src/components/ai-suggestions/host.tsx",
              "apps/web/src/components/bilingual-run-panel.tsx",
              "apps/web/src/components/chat-mention-list.tsx",
              "apps/web/src/components/chat/ask-user-card.tsx",
              "apps/web/src/components/chat/chat-prompt-improve-button.tsx",
              "apps/web/src/components/chat/chat-thread-messages.tsx",
              "apps/web/src/components/chat/message-export-menu.tsx",
              "apps/web/src/components/chat/needs-matter-card.tsx",
              "apps/web/src/components/chat/spawn-subagents-card.tsx",
              "apps/web/src/components/chat/tool-approval-card.tsx",
              "apps/web/src/components/docx/docx-browser-editor.tsx",
              "apps/web/src/components/inspector/desktop-open-button.tsx",
              "apps/web/src/components/inspector/document-ai-source-bar.tsx",
              "apps/web/src/components/inspector/file-tab-panel.tsx",
              "apps/web/src/components/inspector/inspector-facet-bar.tsx",
              "apps/web/src/components/pdf/creating-citations.tsx",
              "apps/web/src/components/pdf/pdf-viewer.tsx",
              "apps/web/src/components/pdf/peek/peek-pdf-viewer.tsx",
              "apps/web/src/components/pdf/versions-sidebar.tsx",
              "apps/web/src/components/saved-searches.tsx",
              "apps/web/src/components/search-dialog-results.tsx",
              "apps/web/src/components/search-dialog.tsx",
              "apps/web/src/components/translate-document-dialog.tsx",
              "apps/web/src/components/versions/version-list.tsx",
              "apps/web/src/components/workspaces/entity-kind-icon.tsx",
              "apps/web/src/components/workspaces/field-value.tsx",
              "apps/web/src/features/chat/components/chat-title-rename.tsx",
              "apps/web/src/routes/_protected.chat/-components/chat-thread-recap.tsx",
              "apps/web/src/routes/_protected.contacts/-procuracao-extraction.tsx",
              "apps/web/src/routes/_protected.contacts/import.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/blueprint-gallery-sheet.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/catalogue/add-mcp-server-sheet.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/catalogue/catalogue-browser.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/catalogue/catalogue-detail-panel.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/catalogue/install-pack-button.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/clause-detail.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/clause-editor.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/import-skill-dialog.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/playbook-starter-cards.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/template-clauses-tab.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/template-studio-chat.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/template-studio-fields.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/template-studio-inspector.tsx",
              "apps/web/src/routes/_protected.knowledge/-components/template-studio-selection-gesture.tsx",
              "apps/web/src/routes/_protected.settings/-components/account/two-factor-card.tsx",
              "apps/web/src/routes/_protected.settings/account.profile.tsx",
              "apps/web/src/routes/_protected.settings/organization.usage.tsx",
              "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/billing/time-entry-row.tsx",
              "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/billing/timer-controls.tsx",
              "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/existing-file-organizer-dialog.tsx",
              "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/extraction-run-progress.tsx",
              "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar.tsx",
              {
                path: "packages/ui/src/components/button.tsx",
                reason:
                  "The Button `loading` state spins a lucide icon in place of the button's own icon; it moves to `Loader` once the size-in-slot behaviour is ported.",
              },
              {
                path: "packages/ui/src/components/toast.tsx",
                reason:
                  "The loading toast type spins a lucide icon in the toast's icon slot; it moves to `Loader` with the button port.",
              },
              "packages/workspace-ui/src/field-value.tsx",
            ],
          },
        ],
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/no-legacy-entity-route.fixture.tsx",
      ],
      rules: {
        "no-legacy-entity-route/no-legacy-entity-route": "error",
      },
    },
    {
      files: [".oxlint-plugins/__fixtures__/require-use-shallow.fixture.tsx"],
      rules: { "require-use-shallow/require-use-shallow": "error" },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/require-stable-editor-options.fixture.tsx",
      ],
      rules: {
        "require-stable-editor-options/require-stable-editor-options": "error",
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/require-stable-snapshot.fixture.tsx",
      ],
      rules: { "require-stable-snapshot/require-stable-snapshot": "error" },
    },
    {
      files: [".oxlint-plugins/__fixtures__/require-escape-like.fixture.ts"],
      rules: { "require-escape-like/require-escape-like": "error" },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/no-static-catalogue-route-import.fixture.tsx",
      ],
      rules: {
        "no-static-catalogue-route-import/no-static-catalogue-route-import": [
          "error",
          {
            routeFiles: [
              ".oxlint-plugins/__fixtures__/no-static-catalogue-route-import.fixture.tsx",
            ],
          },
        ],
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/no-static-devtools-import.fixture.tsx",
      ],
      rules: {
        "no-static-devtools-import/no-static-devtools-import": "error",
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/no-shared-suspense-query.fixture.tsx",
      ],
      rules: {
        "no-shared-suspense-query/no-shared-suspense-query": "error",
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/require-loader-prefetch.fixture.tsx",
        ".oxlint-plugins/__fixtures__/require-loader-prefetch-loader.fixture.tsx",
        ".oxlint-plugins/__fixtures__/require-loader-prefetch-nonroute.fixture.tsx",
        ".oxlint-plugins/__fixtures__/require-loader-prefetch-nosuspense.fixture.tsx",
        ".oxlint-plugins/__fixtures__/routes/-components/require-loader-prefetch-child.fixture.tsx",
        ".oxlint-plugins/__fixtures__/routes/require-loader-prefetch-child-missing.fixture.tsx",
        ".oxlint-plugins/__fixtures__/routes/require-loader-prefetch-child-ok.fixture.tsx",
      ],
      rules: {
        "require-loader-prefetch/require-loader-prefetch": "error",
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/no-strict-route-read-in-chrome.fixture.tsx",
      ],
      rules: {
        "no-strict-route-read-in-chrome/no-strict-route-read-in-chrome":
          "error",
      },
    },
    {
      files: [".oxlint-plugins/__fixtures__/no-bare-chrome-query.fixture.tsx"],
      rules: {
        "no-bare-chrome-query/no-bare-chrome-query": "error",
      },
    },
    {
      // Evals are scripts too: on-demand model runs that print reports.
      files: ["**/scripts/**", "**/evals/**"],
      rules: {
        "no-console": "off",
        // `noPropertyAccessFromIndexSignature` requires bracket access on the
        // index-signature types these config/JSON parsers work with, which is
        // exactly what `dot-notation` flags. Keep the rule for real named
        // properties; allow the bracket form the compiler mandates.
        "typescript/dot-notation": [
          "error",
          { allowIndexSignaturePropertyAccess: true },
        ],
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
      // Astro's content config wires virtual loader/schema helpers that
      // oxlint's type-aware pass sees as error-typed outside Astro's checker.
      files: ["apps/landing/src/content.config.ts"],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
      },
    },
    {
      // TipTap v3 builds `Editor.chain()` (ChainedCommands) and `isActive`
      // from a large intersection of module-augmented command interfaces.
      // oxlint's type-aware pass resolves the editor to `error`-typed here
      // (the only web consumer of toggleBold/toggleHeading/isActive), while
      // tsc --noEmit type-checks the file clean.
      files: [
        "apps/web/src/routes/_protected.knowledge/-components/clause-editor.tsx",
      ],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/strict-boolean-expressions": "off",
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
      // Playwright end-to-end tests. They run outside the app process
      // (no env module, no `panic()` plumbing) and talk to a live HTTP
      // API where bare `throw new Error(...)` is the right signal.
      files: ["apps/web/e2e/**/*.ts"],
      rules: {
        "no-console": "off",
        "no-bare-error/no-bare-error": "off",
        "no-non-null-assertion": "off",
        "typescript/no-unsafe-type-assertion": "off",
        "forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts":
          "off",
      },
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
        "apps/web/src/components/workspaces/create-property.tsx",
      ],
      rules: { "require-unicode-regexp": "off" },
    },
    {
      // The tokenizer regex here is a standard quoted-string-with-escapes
      // matcher (linear in practice). Naming its capture group to satisfy
      // prefer-named-capture-group puts the line into the PR diff, which
      // re-surfaces a CodeQL "polynomial regular expression" false positive
      // on a pattern that already exists on main. Keep the regex byte-
      // identical to main and disable the rule for this single-regex file.
      files: ["packages/template-conditions/src/index.ts"],
      rules: { "prefer-named-capture-group": "off" },
    },
    {
      files: ["apps/web/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
      rules: {
        "no-raw-colors/no-raw-colors": "error",
        "no-raw-foreground-opacity/no-raw-foreground-opacity": "error",
        "no-inline-style-colors/no-inline-style-colors": "error",
        "no-physical-properties/no-physical-properties": "error",
      },
    },
    {
      // Two guards contradict each other in apps/web; this override picks one.
      //
      // React Compiler: bails out of any component or hook containing a logical
      // assignment operator (`??=`, `||=`, `&&=`), and a bailed-out function is
      // memoized not at all. scripts/rc-bailouts.ts baselines every bailout.
      //
      // prefer-nullish-coalescing: wants every `if (x === null) x = ...`
      // rewritten as `??=`, the exact syntax that costs the memoization.
      //
      // Resolution: keep the `if` spelling where the compiler runs, which is
      // apps/web/src alone; everything else keeps the stricter rule. Options are
      // restated in full because oxlint resolves overrides by replacement, not
      // merge.
      files: ["apps/web/src/**/*.{ts,tsx}"],
      rules: {
        "typescript/prefer-nullish-coalescing": [
          "error",
          {
            ignoreIfStatements: true,
            ignorePrimitives: { string: true, boolean: true },
          },
        ],
      },
    },
    {
      // Browser surfaces only: `document` does not exist in apps/api's
      // Bun runtime. CLAUDE.md: "No direct document.cookie assignment."
      files: [
        ...browserSurfaceFiles,
        ".oxlint-plugins/__fixtures__/no-document-cookie.fixture.ts",
      ],
      rules: {
        "no-document-cookie/no-document-cookie": "error",
      },
    },
    {
      // Window-opening primitives are restricted to the isolated navigation
      // boundary and the validated OAuth compatibility path.
      files: [
        ...browserSurfaceFiles,
        ".oxlint-plugins/__fixtures__/require-safe-window-open.fixture.ts",
      ],
      excludeFiles: [
        "apps/web/src/lib/open-isolated-window.ts",
        // OAuth intentionally preserves opener as a BroadcastChannel fallback;
        // this module owns origin/schema validation for that narrow exception.
        "apps/web/src/lib/mcp-oauth-channel.ts",
      ],
      rules: {
        "require-safe-window-open/require-safe-window-open": "error",
      },
    },
    {
      // Browser-owned resources and credentials require paired object-URL
      // cleanup and server-managed auth cookies. Navigation exceptions above
      // must not weaken these independent boundaries.
      files: [
        ...browserSurfaceFiles,
        ".oxlint-plugins/__fixtures__/no-object-url-leak.fixture.ts",
        ".oxlint-plugins/__fixtures__/no-auth-token-in-web-storage.fixture.ts",
      ],
      rules: {
        "no-object-url-leak/no-object-url-leak": "error",
        "no-auth-token-in-web-storage/no-auth-token-in-web-storage": "error",
      },
    },
    {
      // Path containment is a filesystem concern. The rule traces Node path
      // imports and ignores generic string-prefix checks.
      files: [
        "apps/**/*.{ts,tsx}",
        "packages/**/*.{ts,tsx}",
        "scripts/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-path-prefix-containment.fixture.ts",
      ],
      rules: {
        "no-path-prefix-containment/no-path-prefix-containment": "error",
      },
    },
    {
      // An exhaustiveness check must fail loudly. Both `const x: never = value`
      // and `return value satisfies never` type-check and then hand the
      // unhandled value back at runtime, so a widened union flows on as if it
      // had been handled. The assertion belongs on its own line, with
      // `panic(...)` after it. Tests are exempt: a fixture may bind the value
      // to prove a helper rejects it.
      // Scope mirrors ALL_SOURCE_GLOBS in scripts/source-globs.ts, plus the
      // `evals` and `e2e` trees it leaves out: a widened union returned from a
      // backfill script or an eval harness is the same defect as one returned
      // from a handler.
      files: [
        "apps/*/src/**/*.{ts,tsx}",
        "apps/*/scripts/**/*.{ts,tsx}",
        "apps/*/evals/**/*.{ts,tsx}",
        "apps/*/e2e/**/*.{ts,tsx}",
        "packages/*/src/**/*.{ts,tsx}",
        "packages/*/scripts/**/*.{ts,tsx}",
        "scripts/**/*.{ts,tsx}",
        ".oxlint-plugins/**/*.{ts,tsx}",
      ],
      excludeFiles: [
        "**/*.{test,spec}.{ts,tsx}",
        "**/*.db.test.ts",
        "**/*.property.test.ts",
        "**/tests/**",
        "**/__tests__/**",
      ],
      rules: {
        "require-exhaustive-panic/require-exhaustive-panic": "error",
      },
    },
    {
      // Web Streams readers own a lock and, on premature termination, the
      // upstream producer. Keep that lifecycle paired across every runtime.
      files: [
        "apps/**/*.{ts,tsx}",
        "packages/**/*.{ts,tsx}",
        "scripts/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/require-stream-reader-disposal.fixture.ts",
      ],
      rules: {
        "require-stream-reader-disposal/require-stream-reader-disposal":
          "error",
      },
    },
    {
      // Product source: ban the value-level `void` operator so a floating
      // promise is routed through the `detached(promise, context)` helper
      // instead of throwing its rejection away. The `void` TYPE keyword is a
      // different AST node and is untouched. Shared packages are in scope
      // too: they had no guard, and a rejection dropped in a package is as
      // invisible as one dropped in an app.
      files: [
        "apps/api/src/**/*.{ts,tsx}",
        "apps/web/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-detached-void.fixture.ts",
      ],
      rules: {
        "no-detached-void/no-detached-void": "error",
      },
    },
    {
      // The other half of the detached-promise guard: `.catch(() => null)`
      // passes every floating-promise check while discarding the rejection,
      // which is what the `void` ban exists to prevent. Product code only;
      // resource teardown and response-body reads are allowlisted in the rule.
      files: [
        "apps/api/src/**/*.{ts,tsx}",
        "apps/web/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-swallowed-rejection.fixture.ts",
      ],
      rules: {
        "no-swallowed-rejection/no-swallowed-rejection": "error",
      },
    },
    {
      // The third part of the detached-promise guard: the label is the only
      // thing identifying a captured rejection, so it must be a dotted
      // `feature.action` literal rather than the enclosing component or
      // handler name. Scoped to the two apps that can import the helper
      // (`apps/web/src/lib/detached.ts`, `apps/api/src/lib/detached.ts`);
      // no package ships one. Tests are in scope: a detached label there is
      // a telemetry tag like any other, and no test detaches today.
      files: [
        "apps/api/src/**/*.{ts,tsx}",
        "apps/web/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/require-detached-label-shape.fixture.ts",
      ],
      rules: {
        "require-detached-label-shape/require-detached-label-shape": "error",
      },
    },
    {
      // Swallowing a rejection in a test is how a test asserts that nothing
      // downstream depends on it. Mirror the detached-promise exclusion.
      files: [
        "apps/api/src/**/*.{test,spec}.{ts,tsx}",
        "apps/api/src/**/tests/**",
        "apps/api/src/**/__tests__/**",
        "apps/web/src/**/*.{test,spec}.{ts,tsx}",
        "apps/web/src/**/tests/**",
        "apps/web/src/**/__tests__/**",
        "packages/*/src/**/*.{test,spec}.{ts,tsx}",
        "packages/*/src/**/tests/**",
        "packages/*/src/**/__tests__/**",
      ],
      rules: {
        "no-swallowed-rejection/no-swallowed-rejection": "off",
      },
    },
    {
      // Tests are outside the detached-promise ratchet's scope: a bare
      // `void trigger()` to fire-and-forget without capture is fine in a
      // test. Mirror that exclusion so the rule matches the ratchet.
      files: [
        "apps/api/src/**/*.{test,spec}.{ts,tsx}",
        "apps/api/src/**/tests/**",
        "apps/api/src/**/__tests__/**",
        "apps/web/src/**/*.{test,spec}.{ts,tsx}",
        "apps/web/src/**/tests/**",
        "apps/web/src/**/__tests__/**",
        "packages/*/src/**/*.{test,spec}.{ts,tsx}",
        "packages/*/src/**/tests/**",
        "packages/*/src/**/__tests__/**",
      ],
      rules: {
        "no-detached-void/no-detached-void": "off",
      },
    },
    {
      // Error toasts: scoped to apps/web, the only surface that raises
      // `stellaToast`. A handler that shows an error toast without binding
      // and capturing the caught error surfaces the failure to one user and
      // to nobody else.
      files: [
        "apps/web/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/require-toast-error-capture.fixture.ts",
      ],
      rules: {
        "require-toast-error-capture/require-toast-error-capture": "error",
      },
    },
    {
      // Deterministic backend logic must receive wall-clock time and entropy
      // from its caller. Start with pure policy, normalization, codec, and
      // classification modules; I/O boundaries continue to own the ambient
      // clock until their APIs expose an injected clock.
      files: [
        "apps/api/src/**/*.logic.ts",
        "apps/api/src/**/*-policy.ts",
        "apps/api/src/**/*-normalizer.ts",
        "apps/api/src/**/*-codec.ts",
        "apps/api/src/handlers/case-law/ingestion/reconciliation-plan.ts",
        "apps/api/src/handlers/case-law/polarity/classifier.ts",
        "apps/api/src/handlers/case-law/polarity/rule-engine.ts",
        ".oxlint-plugins/__fixtures__/no-ambient-nondeterminism.fixture.ts",
      ],
      rules: {
        "no-ambient-nondeterminism/no-ambient-nondeterminism": "error",
      },
    },
    {
      // An ambient async-context store is per-request state, and `enterWith`
      // is the one way to bind it that outlives the work it was opened for:
      // the frame it mutates stays current for whatever the runtime dispatches
      // next, so a background loop resuming there adopts the store and keeps
      // it. Scoped to every runtime that serves requests alongside long-lived
      // background work.
      files: [
        "apps/*/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-async-context-enter-with.fixture.ts",
      ],
      rules: {
        "no-async-context-enter-with/no-async-context-enter-with": "error",
      },
    },
    {
      // The other half of the type-cost guard: awaiting a ternary whose
      // branches are two chain states of one query builder instantiates both
      // builder types and their union before `Awaited<>` resolves. Scoped to
      // the backend and shared packages, where the Drizzle handles and other
      // fluent generic builders live; apps/web has no query builder.
      files: [
        "apps/api/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-awaited-builder-union.fixture.ts",
      ],
      rules: {
        "no-awaited-builder-union/no-awaited-builder-union": "error",
      },
    },
    {
      // A use-intl translator is an overloaded callable whose signatures span
      // the whole message catalogue. Passing it through a broad helper type can
      // turn one assignability check into minutes of compiler work.
      files: [
        "apps/web/src/**/*.{ts,tsx}",
        "apps/landing/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-broad-translation-callable.fixture.ts",
      ],
      rules: {
        "no-broad-translation-callable/no-broad-translation-callable": "error",
      },
    },
    {
      // Persisted-storage reads: scoped to apps/web, the only surface that
      // reads localStorage/sessionStorage. The helper module itself is the
      // one place a raw JSON.parse on a persisted string is intentional.
      files: [
        "apps/web/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-raw-stored-json.fixture.ts",
      ],
      excludeFiles: ["apps/web/src/lib/stored-json.ts"],
      rules: {
        "no-raw-stored-json/no-raw-stored-json": "error",
      },
    },
    {
      // Eden treaty calls (api.* from @/lib/api) resolve { data, error }
      // and never throw, so consuming them with .then()/.catch() lets a
      // failed request masquerade as success. Scoped to product code;
      // logic tests exercise mocked responses directly, not live chains.
      files: ["apps/web/src/**/*.{ts,tsx}"],
      excludeFiles: ["apps/web/src/**/*.test.{ts,tsx}"],
      rules: {
        "require-eden-error-check/require-eden-error-check": "error",
      },
    },
    {
      // The entity detail redirect route was removed. Keep its old public URL
      // out of source so every caller supplies a canonical destination.
      files: ["apps/web/src/**/*.{ts,tsx}"],
      rules: {
        "no-legacy-entity-route/no-legacy-entity-route": "error",
      },
    },
    {
      // Cache invalidation must go through the per-feature key factories:
      // a hand-typed key or an inline positional predicate keeps compiling
      // after the factory's shape moves, and silently matches nothing.
      // Tests may pin a key's wire shape, so they state literals directly.
      files: ["apps/web/src/**/*.{ts,tsx}"],
      excludeFiles: ["apps/web/src/**/*.{test,spec}.{ts,tsx}"],
      rules: {
        "require-query-key-factory/require-query-key-factory": "error",
      },
    },
    {
      // Resource identity URIs have one encoding owner. Tests may pin their
      // wire representation, while production callers use the serializers.
      files: [
        "apps/**/*.{ts,tsx}",
        "packages/**/*.{ts,tsx}",
        "scripts/**/*.{ts,tsx}",
      ],
      excludeFiles: [
        "**/*.{test,spec}.{ts,tsx}",
        "**/__tests__/**/*.{ts,tsx}",
        "packages/api-contract/src/resource-link.ts",
        "packages/api-contract/src/resource-ref.ts",
      ],
      rules: {
        "no-raw-resource-uri/no-raw-resource-uri": "error",
      },
    },
    {
      files: [
        "apps/api/src/lib/markdown/chat-message.ts",
        "packages/api-contract/src/resource-link.ts",
        "packages/api-contract/src/resource-ref.ts",
      ],
      rules: {
        "no-raw-resource-uri/require-rfc3986-resource-encoding": "error",
      },
    },
    {
      // A centered, width-capped content column must not own the vertical
      // scroll, or the scrollbar floats at the column edge instead of the pane
      // edge next to the inspector rail. Scoped to apps/web (the app shell with
      // the inspector rail); folio has its own document scroll model.
      files: [
        "apps/web/src/**/*.tsx",
        ".oxlint-plugins/__fixtures__/no-centered-scroll-column.fixture.tsx",
      ],
      rules: {
        "no-centered-scroll-column/no-centered-scroll-column": "error",
      },
    },
    {
      // Icon-only actions need visible hover/focus affordance for sighted users;
      // aria-label alone is not discoverable. Decorative icons are ignored.
      files: [
        "apps/web/src/**/*.tsx",
        ".oxlint-plugins/__fixtures__/icon-button-requires-tooltip.fixture.tsx",
      ],
      rules: {
        "icon-button-requires-tooltip/icon-button-requires-tooltip": "error",
      },
    },
    {
      // The companion to the rule above: a tooltip wrapped around a disabled
      // Button never opens, because the button receives no hover or focus.
      // Button's own `tooltip` prop keeps it reachable while blocking
      // activation; an outer wrapper cannot.
      files: [
        "apps/*/src/**/*.tsx",
        "packages/*/src/**/*.tsx",
        ".oxlint-plugins/__fixtures__/no-disabled-tooltip-trigger.fixture.tsx",
      ],
      rules: {
        "no-disabled-tooltip-trigger/no-disabled-tooltip-trigger": "error",
      },
    },
    {
      // A dialog trigger mounted inside a menu item needs
      // `closeOnClick={false}` to survive the click, which means the menu
      // cannot close under the dialog it opens. Lift the dialog beside the
      // menu with its own `open` state instead.
      files: [
        "apps/*/src/**/*.tsx",
        "packages/*/src/**/*.tsx",
        ".oxlint-plugins/__fixtures__/no-dialog-trigger-menu-item.fixture.tsx",
      ],
      rules: {
        "no-dialog-trigger-menu-item/no-dialog-trigger-menu-item": "error",
      },
    },
    {
      // `Omit<Props, "k">` narrows what a caller may write, not what a value
      // can carry: a wider props object stays assignable and the rest object
      // keeps every runtime key, so `{...props}` re-applies the omitted key
      // unless the component pins it after the last spread.
      files: [
        "apps/*/src/**/*.tsx",
        "packages/*/src/**/*.tsx",
        ".oxlint-plugins/__fixtures__/no-omitted-prop-respread.fixture.tsx",
      ],
      rules: {
        "no-omitted-prop-respread/no-omitted-prop-respread": "error",
      },
    },
    {
      // A nested callback naming its parameter `props` is the accepted case
      // this fixture pins: the shadowed binding must not be charged to the
      // enclosing component's omission. The shadowing is the test.
      files: [
        ".oxlint-plugins/__fixtures__/no-omitted-prop-respread.fixture.tsx",
      ],
      rules: {
        "no-shadow": "off",
      },
    },
    {
      files: ["apps/web/src/**/*.{ts,tsx}"],
      rules: {
        "no-ambient-hotkey-format/no-ambient-hotkey-format": "error",
      },
    },
    {
      // Locale-aware number/date formatting. Folio is excluded: its
      // document surface stays LTR-based and formats with its own
      // resolved locales rather than the UI numbering preference.
      files: [
        "apps/web/src/**/*.{ts,tsx}",
        "packages/ui/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-raw-locale-format.fixture.ts",
      ],
      rules: {
        "no-raw-locale-format/no-raw-locale-format": "error",
      },
    },
    {
      // Date/timezone footguns: date-only `new Date("...")` (UTC-midnight
      // shift), `Date.parse` (engine-dependent), and raw day-length ms
      // arithmetic (DST-unsafe). Use parseIsoDateLocal/addDays and DAY_IN_MS
      // from `@stll/time`.
      files: [
        "apps/api/src/**/*.{ts,tsx}",
        "apps/web/src/**/*.{ts,tsx}",
        "apps/legal-atlas-runner/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-raw-date-parsing.fixture.ts",
      ],
      rules: {
        "no-raw-date-parsing/no-raw-date-parsing": "error",
      },
    },
    {
      // Tests construct fixture instants from literals deterministically and
      // deliberately demonstrate the footguns (e.g. the dates.test.ts DST
      // assertions), so the date-parsing rule stays out of them. The helpers
      // and the day-length literal live in the `@stll/time` package, which
      // this rule (scoped to the app source trees above) does not cover.
      files: [
        "apps/api/src/**/*.{test,spec}.{ts,tsx}",
        "apps/web/src/**/*.{test,spec}.{ts,tsx}",
        "apps/legal-atlas-runner/src/**/*.{test,spec}.{ts,tsx}",
        "apps/api/src/**/__tests__/**",
        "apps/api/src/tests/**",
      ],
      rules: {
        "no-raw-date-parsing/no-raw-date-parsing": "off",
      },
    },
    {
      // Bidirectional: the shared <Input>/<Textarea> own field direction, so a
      // literal dir="auto" is forbidden (it strands the caret left when empty);
      // numeric inputs must be explicitly dir="ltr".
      files: [
        "apps/web/src/**/*.tsx",
        "packages/ui/src/**/*.tsx",
        ".oxlint-plugins/__fixtures__/no-input-dir-auto.fixture.tsx",
      ],
      rules: {
        "no-input-dir-auto/no-input-dir-auto": "error",
      },
    },
    {
      // Bidirectional: rendering a user-provided name needs `dir` so it
      // isn't reordered under RTL.
      files: [
        "apps/web/src/**/*.tsx",
        "packages/ui/src/**/*.tsx",
        ".oxlint-plugins/__fixtures__/require-dir-on-rendered-name.fixture.tsx",
      ],
      rules: {
        "require-dir-on-rendered-name/require-dir-on-rendered-name": "error",
      },
    },
    {
      // Numbers must go through the locale formatter so digits localize.
      files: [
        "apps/web/src/**/*.tsx",
        "packages/ui/src/**/*.tsx",
        ".oxlint-plugins/__fixtures__/no-unformatted-number.fixture.tsx",
      ],
      rules: {
        "no-unformatted-number/no-unformatted-number": "error",
      },
    },
    {
      // How many minor units make a major one is a property of the currency,
      // so a literal 100 is only right for the currencies that happen to have
      // two. Every app and package that touches an amount goes through the
      // conversion helpers in `@stll/money` instead.
      files: [
        "apps/*/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-literal-minor-unit-scale.fixture.ts",
      ],
      rules: {
        "no-literal-minor-unit-scale/no-literal-minor-unit-scale": "error",
      },
    },
    {
      files: ["packages/ui/src/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [noZodImport, uiPragmaticDragAdapterImport],
            patterns: [
              ...uiStandaloneImports,
              pragmaticDragAdapterDeepImportBan,
            ],
          },
        ],
      },
    },
    {
      // The kanban package's drag-and-drop owner: the one module that may
      // call the adapter's `draggable`/`dropTargetForElements` directly. The
      // rest of the package's import restrictions still apply.
      files: ["packages/ui/src/kanban/drag-interactions.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [noZodImport],
            patterns: [
              ...uiStandaloneImports,
              pragmaticDragAdapterDeepImportBan,
            ],
          },
        ],
      },
    },
    {
      // The package's convenience entry, and the one file that has to be a
      // barrel: `exports["."]` needs a module, and a published package with no
      // root export is one nobody can import by name. The per-module subpaths
      // are the tree-shakeable path and are what in-repo code uses;
      // `sideEffects: false` plus one output module per source module keeps a
      // bundler from paying for re-exports it does not touch.
      files: ["packages/ui/src/index.ts"],
      rules: { "oxc/no-barrel-file": "off" },
    },
    {
      // The workspace kit's components came out of apps/web and keep its key
      // hygiene: a list keyed by index is the same bug here. Only `jsx-key` and
      // `no-array-index-key`, so the package is not swept for the rest of the
      // app's set.
      files: ["packages/workspace-ui/src/**/*.{ts,tsx}"],
      rules: {
        "react/jsx-key": "error",
        "react/no-array-index-key": "error",
      },
    },
    {
      files: ["apps/web/src/hooks/use-effect.ts"],
      rules: {
        // These generic wrappers intentionally accept opaque callbacks and
        // dependency arrays. Their call sites own dependency correctness, so
        // the compiler cannot analyze them as ordinary component hooks.
        ...reactCompilerRulesOff,
      },
    },
    {
      files: ["apps/web/src/**/*.{ts,tsx}"],
      rules: {
        "react/jsx-key": "error",
        "react/no-array-index-key": "error",
        "require-cn-for-classname-composition/require-cn-for-classname-composition":
          "error",
        // Direct useEffect is banned; route external-system sync through
        // useMountEffect / useExternalSyncEffect. See /conventions-use-effect.
        "no-raw-use-effect/no-raw-use-effect": [
          "error",
          { allowedFiles: ["apps/web/src/hooks/use-effect.ts"] },
        ],
        // useExternalSyncEffect takes a dependency array, so exhaustive-deps
        // must inspect it like useEffect. useMountEffect is deliberately
        // dependency-less (mount-only) and is left unregistered.
        "react-hooks/exhaustive-deps": [
          "error",
          { additionalHooks: "(useExternalSyncEffect)" },
        ],
        "@tanstack/query/exhaustive-deps": "error",
        "@tanstack/query/infinite-query-property-order": "error",
        "@tanstack/query/mutation-property-order": "error",
        "@tanstack/query/no-rest-destructuring": "error",
        "@tanstack/query/no-unstable-deps": "error",
        "@tanstack/query/stable-query-client": "error",
        "require-query-signal/require-query-signal": "error",
        "no-ref-mirror/no-ref-mirror": [
          "error",
          {
            // Existing render-body ref mirrors. Keep the rule as a ratchet:
            // new files cannot add this pattern, while these legacy files are
            // kept only when the mutable ref is not an effect-callback shim.
            allowedFiles: [
              {
                path: "apps/web/src/components/chat-editor-provider.tsx",
                reason:
                  "Tiptap extension callbacks and ordinary editor event handlers read latest placeholder, attachments, and slash items; useEffectEvent is not for third-party plugin/event callbacks.",
              },
              {
                path: "apps/web/src/components/inspector/versions-facet.tsx",
                reason:
                  "Older-version paging updates the seeded query identity during render so in-flight page responses can be discarded before the passive-effect window; useEffectEvent would not protect this async race.",
              },
              {
                path: "apps/web/src/features/chat/hooks/use-chat-session.ts",
                reason:
                  "Older-message paging updates the seeded Chat identity during render so stale in-flight page responses are discarded across thread switches and same-thread refetches.",
              },
              {
                path: "apps/web/src/components/templates/template-form.tsx",
                reason:
                  "Form refs bridge synchronous onChange/onBlur ordering before React commits, so validation reads the latest field values and touched state inside ordinary event handlers.",
              },
              {
                path: "apps/web/src/components/workspaces/hooks/use-create-b-boxes.ts",
                reason:
                  "Returned callback identity must stay stable for downstream effect deps while reading latest pending mutation count; callers invoke it directly, not from an effect-installed callback.",
              },
            ],
          },
        ],
        // A Zustand selector returning a fresh object/array literal fails
        // Object.is every render; under Zustand v5 that can loop into
        // "Maximum update depth exceeded". Wrap the selector in useShallow.
        "require-use-shallow/require-use-shallow": "error",
        // A useSyncExternalStore snapshot that never stabilizes trips
        // React's getSnapshot-cache warning and can loop the same way.
        "require-stable-snapshot/require-stable-snapshot": "error",
        // `useEditor` options rebuilt per render make the react binding
        // re-apply editor view props on every render; on per-keystroke
        // re-render surfaces that churn can interleave with ProseMirror's
        // DOMObserver and loop into "Maximum update depth exceeded".
        "require-stable-editor-options/require-stable-editor-options": "error",
        "no-restricted-imports": [
          "error",
          {
            paths: [noZodImport, webPragmaticDragAdapterImport],
            patterns: [
              {
                group: webLocalApiImportGroup,
                message: "Use '@/lib/api-contract' instead of '@/api/'.",
              },
              ...webCrossWorkspaceImports,
              webDatePickerImport,
              pragmaticDragAdapterDeepImportBan,
            ],
          },
        ],
        "no-raw-api-url/no-direct-api-env": "error",
        "no-raw-api-url/no-raw-api-url": "error",
        // Catch raw JSX copy across product UI. Use narrow disables only for
        // non-user-facing literals such as technical fixtures or brand marks.
        "no-untranslated-jsx-literal/no-untranslated-jsx-literal": [
          "error",
          { allowedText: ["Anthropic", "Google AI", "OpenAI"] },
        ],
        "require-router-select/require-router-select": "error",
        "no-optional-mutation-command/no-optional-mutation-command": "error",
        "no-raw-router-invalidation/no-raw-router-invalidation": "error",
        "require-matter-affordance/require-matter-affordance": "error",
        "security-guards/no-unsanitized-href": "error",
        "stella-toast/stella-toast": "error",
      },
    },
    {
      // The kanban drag-and-drop owner: the one web module that may call the
      // adapter's `draggable`/`dropTargetForElements` directly (it exports
      // the conflict-guarded `attachElementDropTarget` every kanban drop
      // target and the column draggable go through). Every other apps/web
      // import restriction still applies, so it is restated here.
      files: [
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/kanban/use-kanban-drop-targets.ts",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [noZodImport],
            patterns: [
              {
                group: webLocalApiImportGroup,
                message: "Use '@/lib/api-contract' instead of '@/api/'.",
              },
              ...webCrossWorkspaceImports,
              webDatePickerImport,
              pragmaticDragAdapterDeepImportBan,
            ],
          },
        ],
      },
    },
    {
      files: [
        "apps/web/src/routes/dev/**/*.{ts,tsx}",
        "apps/web/src/components/dev/**/*.{ts,tsx}",
        "apps/web/src/components/dev-sidebar-group.tsx",
      ],
      rules: {
        "no-untranslated-jsx-literal/no-untranslated-jsx-literal": "off",
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/require-matter-affordance.fixture.tsx",
      ],
      rules: {
        "require-matter-affordance/require-matter-affordance": "error",
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/no-workspace-field-value-drift.fixture.tsx",
      ],
      rules: {
        "no-workspace-field-value-drift/no-workspace-field-value-drift":
          "error",
      },
    },
    {
      files: [".oxlint-plugins/__fixtures__/require-query-limit.fixture.ts"],
      rules: {
        "require-query-limit/require-query-limit": "error",
      },
    },
    {
      files: [".oxlint-plugins/__fixtures__/require-search-scope.fixture.ts"],
      rules: {
        "require-search-scope/require-search-scope": "error",
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/no-direct-ingestion-checkpoint-write.fixture.ts",
      ],
      rules: {
        "no-direct-ingestion-checkpoint-write/no-direct-ingestion-checkpoint-write":
          "error",
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/no-unowned-file-version-write.fixture.ts",
      ],
      rules: {
        "no-unowned-file-version-write/no-unowned-file-version-write": "error",
      },
    },
    {
      files: [".oxlint-plugins/__fixtures__/no-db-await-in-loop.fixture.ts"],
      rules: {
        "no-db-await-in-loop/no-db-await-in-loop": "error",
      },
    },
    {
      files: [
        ".oxlint-plugins/__fixtures__/no-network-await-in-loop.fixture.ts",
      ],
      rules: {
        "no-network-await-in-loop/no-network-await-in-loop": "error",
      },
    },
    {
      // The locale-injecting wrapper around the UI date picker: the one web
      // module that has to import the primitive it wraps. Every other
      // apps/web import restriction still applies, so they are restated here.
      files: ["apps/web/src/components/date-picker-popover.tsx"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [noZodImport, webPragmaticDragAdapterImport],
            patterns: [
              {
                group: webLocalApiImportGroup,
                message: "Use '@/lib/api-contract' instead of '@/api/'.",
              },
              ...webCrossWorkspaceImports,
              pragmaticDragAdapterDeepImportBan,
            ],
          },
        ],
      },
    },
    {
      // AI suggestion surfaces are shared lazy components. They can render
      // while the router is activating a match, so user data must come from
      // AuthenticatedUserProvider rather than a route-match store.
      files: ["apps/web/src/components/ai-suggestions/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              noZodImport,
              webPragmaticDragAdapterImport,
              {
                name: "@tanstack/react-router",
                importNames: ["getRouteApi", "useRouteContext"],
                message:
                  "Shared AI suggestion components must read authenticated user data from '@/lib/authenticated-user-context', not an active route match.",
              },
            ],
            patterns: [
              {
                group: webLocalApiImportGroup,
                message: "Use '@/lib/api-contract' instead of '@/api/'.",
              },
              ...webCrossWorkspaceImports,
              webDatePickerImport,
              pragmaticDragAdapterDeepImportBan,
            ],
          },
        ],
      },
    },
    {
      files: [
        "apps/web/src/routes/law/**/*.{ts,tsx}",
        "apps/web/src/features/case-law/**/*.{ts,tsx}",
      ],
      rules: {
        ...publicSsrAmbientStateRules,
        "no-restricted-imports": [
          "error",
          {
            paths: [noZodImport, webPragmaticDragAdapterImport],
            patterns: [
              {
                group: webProtectedRouteImportGroup,
                message:
                  "Public law routes and shared case-law modules must not import protected route code. Move public-safe code to '@/features/case-law' instead.",
              },
              {
                group: webLocalApiImportGroup,
                message: "Use '@/lib/api-contract' instead of '@/api/'.",
              },
              ...webCrossWorkspaceImports,
              webDatePickerImport,
              pragmaticDragAdapterDeepImportBan,
            ],
          },
        ],
      },
    },
    {
      files: [
        "apps/web/src/app-providers.tsx",
        "apps/web/src/components/public-workspace-shell.tsx",
        "apps/web/src/components/sidebar.tsx",
        "apps/web/src/routes/__root.tsx",
        "apps/web/src/routes/tools/**/*.{ts,tsx}",
      ],
      rules: {
        ...publicSsrAmbientStateRules,
      },
    },
    {
      files: ["apps/web/src/routes/law/**/*.{ts,tsx}"],
      rules: {
        "no-raw-public-law-seo/no-raw-public-law-seo": "error",
        "no-restricted-imports": [
          "error",
          {
            paths: [
              noZodImport,
              webPragmaticDragAdapterImport,
              {
                name: "@/lib/api",
                importNames: ["api"],
                message:
                  "Public law route files must use approved public case-law query modules instead of importing the Eden API client directly.",
              },
            ],
            patterns: [
              {
                group: webProtectedRouteImportGroup,
                message:
                  "Public law routes and shared case-law modules must not import protected route code. Move public-safe code to '@/features/case-law' instead.",
              },
              {
                group: webLocalApiImportGroup,
                message: "Use '@/lib/api-contract' instead of '@/api/'.",
              },
              ...webCrossWorkspaceImports,
              webDatePickerImport,
              pragmaticDragAdapterDeepImportBan,
            ],
          },
        ],
      },
    },
    {
      files: [
        "apps/web/src/routes/robots[.]txt.ts",
        "apps/web/src/routes/sitemap[.]xml.ts",
        "apps/web/src/routes/sitemaps/**/*.{ts,tsx}",
        "apps/web/src/lib/public-law-sitemap.ts",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              noZodImport,
              webPragmaticDragAdapterImport,
              {
                name: "@/routes/-auth-context",
                message:
                  "Public SEO endpoints must not load auth/session context.",
              },
              {
                name: "@/routes/-queries",
                importNames: ["sessionOptions", "roleOptions"],
                message:
                  "Public SEO endpoints must not import authenticated query options.",
              },
              {
                name: "@/lib/auth",
                message: "Public SEO endpoints must not import auth clients.",
              },
            ],
            patterns: [
              {
                group: webProtectedRouteImportGroup,
                message:
                  "Public SEO endpoints must not import protected route code.",
              },
              {
                group: webLocalApiImportGroup,
                message:
                  "Public SEO endpoints must use the public case-law API response, not web-local API internals.",
              },
              ...webCrossWorkspaceImports,
              webDatePickerImport,
              pragmaticDragAdapterDeepImportBan,
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
      // button-variants.ts(x) holds the variant styles that used to live
      // in button.tsx (moved for only-export-components); the exemption
      // follows the code.
      files: [
        "packages/ui/src/**/button.tsx",
        "packages/ui/src/**/button-variants.tsx",
      ],
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
        "apps/web/src/**/kanban-column.tsx",
        "apps/web/src/**/workspace-table.tsx",
        "apps/web/src/**/workspace-table/**/*.tsx",
        "apps/web/src/**/template-preview.tsx",
        "apps/web/src/**/page-citation.tsx",
        // Generated message types: UI copy may legitimately contain words
        // like "right-click"; these strings are never class names.
        "apps/web/src/i18n/langs/messages.gen.ts",
      ],
      rules: { "no-physical-properties/no-physical-properties": "off" },
    },
    {
      files: ["apps/web/src/components/pdf/**"],
      rules: {
        "unicorn/prefer-dom-node-remove": "off",
        "unicorn/prefer-dom-node-append": "off",
        "unicorn/prefer-modern-dom-apis": "off",
      },
    },
    {
      files: [
        "apps/web/src/routes/_protected.settings/route.tsx",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/view/view-switcher.tsx",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar.tsx",
      ],
      rules: {
        "no-shared-suspense-query/no-shared-suspense-query": "error",
      },
    },
    {
      // Persistent chrome that mounts on every route: defer cold-cache fetches
      // past mount via useChromeQuery so they cannot warn on a not-yet-mounted
      // fiber. See apps/web/src/hooks/use-chrome-query.ts.
      files: [
        "apps/web/src/routes/_protected.tsx",
        "apps/web/src/components/app-sidebar.tsx",
        "apps/web/src/components/sidebar-user-menu.tsx",
        "apps/web/src/components/require-ai-key.tsx",
        "apps/web/src/components/chat-mention-providers.tsx",
        "apps/web/src/components/chat-editor-provider.tsx",
        "apps/web/src/components/api-version-mismatch-banner.tsx",
        "apps/web/src/components/selfhost-update-banner.tsx",
        "apps/web/src/components/workspaces/create-matter-dialog.tsx",
      ],
      rules: {
        "no-bare-chrome-query/no-bare-chrome-query": "error",
      },
    },
    {
      // Chrome that outlives the route tree it reads from: the inspector keeps
      // the document editor mounted across navigation, and `/law/*` is a
      // top-level tree, so a strict `from: "/_protected"` read throws there.
      // See apps/web/src/lib/authenticated-user-context.tsx for the identity
      // read that survives navigation.
      //
      // The authenticated sidebar and user menu render in both `_protected`
      // and the top-level `/law` tree. Their create-matter flow does too, so
      // those modules must remain route-neutral. Add another component here
      // when it can be mounted while a different top-level tree is active.
      files: [
        "apps/web/src/components/docx/**/*.tsx",
        "apps/web/src/components/docx/**/*.ts",
        "apps/web/src/components/inspector/**/*.tsx",
        "apps/web/src/components/inspector/**/*.ts",
        "apps/web/src/components/ai-suggestions/**/*.tsx",
        "apps/web/src/components/ai-suggestions/**/*.ts",
        "apps/web/src/components/app-sidebar.tsx",
        "apps/web/src/components/contact-picker.tsx",
        "apps/web/src/components/sidebar-user-menu.tsx",
        "apps/web/src/components/workspaces/create-matter-dialog.tsx",
      ],
      rules: {
        "no-strict-route-read-in-chrome/no-strict-route-read-in-chrome":
          "error",
      },
    },
    {
      // Field value display must stay centralized in FieldValue /
      // EditableField. These surfaces own table/kanban/inspector shell
      // behavior, but must not reimplement per-field display branches.
      files: [
        "apps/web/src/components/inspector/entity-metadata-panel.tsx",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/cell-result.tsx",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table-column.tsx",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-card.tsx",
      ],
      rules: {
        "no-workspace-field-value-drift/no-workspace-field-value-drift":
          "error",
      },
    },
    {
      files: [
        "apps/web/src/components/workspaces/field-value.tsx",
        ".oxlint-plugins/__fixtures__/no-workspace-field-value-drift.fixture.tsx",
      ],
      rules: {
        "no-workspace-field-value-drift/no-raw-field-value-bidi-text": "error",
      },
    },
    {
      files: ["apps/web/src/routes/**/*.{ts,tsx}"],
      rules: {
        "@tanstack/router/create-route-property-order": "error",
        "no-beforeload-redirect/no-beforeload-redirect": "error",
        "no-raw-route-query-client/no-raw-route-query-client": "error",
        "require-loader-prefetch/require-loader-prefetch": "error",
      },
    },
    {
      // Public, server-rendered law routes (isPublicSsrPath) must redirect
      // from beforeLoad so the server emits a real HTTP redirect for crawlers
      // and no-JS clients. The client-only blank-page race the rule guards
      // against does not apply to SSR routes.
      files: ["apps/web/src/routes/law/**/*.{ts,tsx}"],
      rules: {
        "no-beforeload-redirect/no-beforeload-redirect": "off",
      },
    },
    {
      files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
      rules: {
        "require-fetch-timeout/require-fetch-timeout": "error",
        "require-escape-like/require-escape-like": "error",
      },
    },
    {
      files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
      rules: {
        "forbid-process-env-outside-env-ts/forbid-process-env-outside-env-ts": [
          "error",
          {
            allowedFiles: [
              // Side-effect-free schema modules are the API's environment
              // boundary. Runtime wrappers import them and instantiate env.
              "apps/api/src/env-base-schema.ts",
              "apps/api/src/env-schema.ts",
              "apps/api/src/env-document-processing-worker.ts",
              "apps/api/src/db-url.ts",
              "apps/api/src/handlers/case-law/ingestion/adapters/utils.ts",
              // Publisher pacing must distinguish deployed runtimes without
              // importing the eager Redis environment schema at module load.
              "apps/api/src/handlers/case-law/ingestion/adapters/publisher-request-gate.ts",
              "apps/api/src/handlers/health/routes.ts",
              "apps/api/src/server.ts",
              "apps/api/src/lib/analytics/posthog.ts",
              // dispatch.ts is imported transitively by the chat tool
              // catalogue from contexts that do not run full env
              // validation (workers, scripts, tests). Reading
              // EDGAR_USER_AGENT and COMPANIES_HOUSE_API_KEY directly
              // from process.env keeps the module side-effect-free at
              // import time; the env schema in apps/api/src/env.ts
              // still declares the variables so the API server
              // validates them on boot.
              "apps/api/src/lib/business-registries/dispatch.ts",
              "apps/api/src/lib/db/assert-migrations-applied.ts",
              "apps/api/src/lib/runtime-worker-path.ts",
              "apps/api/src/lib/s3.ts",
              "apps/api/src/lib/scheduler/runner.ts",
              "apps/api/src/lib/subprocess.ts",
              // Shared APP_VERSION resolution for routes.ts and posthog.ts
              // above; reads STELLA_VERSION/RAILWAY_GIT_COMMIT_SHA directly
              // rather than through env.ts so it stays side-effect-free at
              // import time, matching the two call sites it replaces.
              "apps/api/src/lib/version.ts",
              "apps/web/e2e/helpers/api.ts",
              // Reads E2E_API_URL (same contract as helpers/api.ts) and the
              // E2E_NETWORK_BASELINE write/rewrite mode switch; e2e infra has
              // no app env module to route through.
              "apps/web/e2e/helpers/network.ts",
              // Reads the E2E_EXPECT_DEV_ROUTES dev/production runtime
              // switch so specs share one definition; e2e infra has no app
              // env module to route through.
              "apps/web/e2e/helpers/runtime-mode.ts",
              // Reads E2E_WEB_URL/E2E_API_URL (same contract as
              // helpers/api.ts) plus the MARKETING_CAPTURE and
              // MARKETING_THEME scene/theme switches; e2e infra has no app
              // env module to route through.
              "apps/web/e2e/marketing/record-product-story.ts",
              "apps/web/e2e/staging/global-setup.ts",
              // Test-only helper: reads PROPERTY_TEST_NUM_RUNS_FACTOR and CI
              // to tune fast-check at assert time. Never imported by runtime
              // code, so there is no app env module to route through.
              "packages/property-testing/src/index.ts",
            ],
          },
        ],
      },
    },
    {
      // Configuration must be parsed before dev-runner starts any side effect.
      // The parser adapter is the only owner of process.argv and runner offset
      // environment reads; the orchestration module is guarded here.
      files: ["packages/scripts/src/dev-runner.ts"],
      rules: {
        "forbid-dev-runner-config-reads/forbid-dev-runner-config-reads":
          "error",
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
      // Every workspace mutation must leave an audit trail (SOC 2 /
      // ISO 27001). Scope to handler files — DB writes elsewhere
      // (auth lifecycle hooks, job framework internals, RLS session
      // setup) have different audit semantics and would generate
      // false positives.
      files: ["apps/api/src/handlers/**/*.ts"],
      excludeFiles: ["apps/api/src/handlers/**/*.test.ts"],
      rules: {
        "require-audit-on-mutation/require-audit-on-mutation": "error",
      },
    },
    {
      // Returning a failure value from a transaction callback commits the
      // partial write it was meant to reject. Scoped to the API source, where
      // `safeDb` / `.transaction(...)` open real transactions; the two session
      // openers that must commit alongside their error are named inside the
      // rule.
      files: ["apps/api/src/**/*.ts"],
      excludeFiles: ["apps/api/src/**/*.test.ts", "apps/api/src/tests/**/*.ts"],
      rules: {
        "require-transaction-abort/require-transaction-abort": "error",
      },
    },
    {
      // require-query-limit flags unbounded Drizzle reads (a `findMany`
      // with no `limit`, or an ordered `select` chain with no `.limit()`)
      // per conventions-db / conventions-scale. Genuine list reads carry a
      // `.limit(LIMITS.*)`; reads that are bounded by a single-parent FK
      // filter (a fixed-cardinality relation) carry an inline disable with a
      // `// SAFETY:` note explaining the bound. Test files run unbounded
      // fixtures intentionally and are excluded.
      files: ["apps/api/src/**/*.ts"],
      excludeFiles: ["apps/api/src/**/*.test.ts", "apps/api/src/tests/**/*.ts"],
      rules: {
        "require-query-limit/require-query-limit": "error",
      },
    },
    {
      // Global search reads through rootDb and therefore must reconstruct
      // workspace/contact/chat authorization inside every private projection
      // query. Public case-law search is intentionally outside this rule.
      files: ["apps/api/src/lib/search/**/*.ts"],
      excludeFiles: ["apps/api/src/lib/search/**/*.test.ts"],
      rules: {
        "require-search-scope/require-search-scope": "error",
      },
    },
    {
      // A cursor write is the irreversible boundary of a replay-safe
      // ingestion page. Keep it inside the canonical helper so the ordering
      // is visible and reviewable; schema constraints and fixed-point tests
      // cover the properties static analysis cannot prove.
      files: ["apps/api/src/**/*.ts"],
      excludeFiles: ["apps/api/src/**/*.test.ts", "apps/api/src/tests/**/*.ts"],
      rules: {
        "no-direct-ingestion-checkpoint-write/no-direct-ingestion-checkpoint-write":
          "error",
      },
    },
    {
      // Drizzle enum columns derive their values from a const; the paired
      // check constraint must too, or a new member typechecks, passes the
      // column, and fails the constraint at runtime.
      files: ["apps/api/src/db/schema/**/*.ts"],
      rules: {
        "require-derived-check-enum/require-derived-check-enum": "error",
      },
    },
    {
      // Ordinary and automatic document replacements share one locked,
      // audited transaction. Specialized session finalizers and restore are
      // explicit rule-owned exceptions with separate lifecycle semantics.
      files: ["apps/api/src/**/*.ts"],
      excludeFiles: ["apps/api/src/**/*.test.ts", "apps/api/src/tests/**/*.ts"],
      rules: {
        "no-unowned-file-version-write/no-unowned-file-version-write": "error",
      },
    },
    {
      // no-db-await-in-loop flags an `await db...` / `await tx...` /
      // `await safeDb(...)` or `yield* Result.await(safeDb(...))` lexically
      // inside a loop position that re-runs per iteration, plus a
      // `Promise.all(items.map(...))` fan-out — the N+1 antipattern. Scoped
      // to backend source and the workspace scripts, where `db`/`tx`/`safeDb`
      // are Drizzle handles; test files intentionally exercise unbatched
      // loops in fixtures/mocks and are excluded.
      files: [
        "apps/api/src/**/*.ts",
        "apps/*/scripts/**/*.ts",
        "packages/*/scripts/**/*.ts",
      ],
      excludeFiles: [
        "apps/api/src/**/*.test.ts",
        "apps/api/src/tests/**/*.ts",
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        // Development seeds write fixture data once into a local database;
        // their loop lengths are the fixture's, not a tenant's, so the query
        // count is not a scaling property there.
        "apps/api/scripts/seed-*.ts",
      ],
      rules: {
        "no-db-await-in-loop/no-db-await-in-loop": "error",
      },
    },
    {
      // no-network-await-in-loop flags an awaited HTTP request, AWS SDK
      // command dispatch, or API-client method lexically inside a loop body:
      // one round-trip per iteration, growing with the input. Scoped to
      // product source and the repo scripts; tests drive upstreams by hand
      // and their sequencing is the assertion.
      files: [
        "apps/*/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.{ts,tsx}",
        "apps/*/scripts/**/*.ts",
        "packages/*/scripts/**/*.ts",
        "scripts/**/*.ts",
      ],
      excludeFiles: [
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/tests/**/*.{ts,tsx}",
      ],
      rules: {
        "no-network-await-in-loop/no-network-await-in-loop": "error",
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
      files: ["apps/api/src/handlers/**/*.ts"],
      excludeFiles: ["apps/api/src/handlers/**/*.test.ts"],
      rules: {
        "security-guards/require-secure-document-response": "error",
      },
    },
    {
      // A log attribute key the sanitizer would drop is an error where it is
      // written. Tests are excluded: the logger's own suites and the
      // recording-sink smoke test write such keys on purpose to prove the
      // redaction.
      files: ["apps/api/src/**/*.{ts,tsx}"],
      excludeFiles: [
        "apps/api/src/**/*.test.{ts,tsx}",
        "apps/api/src/tests/**/*.{ts,tsx}",
      ],
      rules: {
        "no-redacted-log-attribute-key/no-redacted-log-attribute-key": "error",
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
        "require-safe-outbound-target/require-safe-outbound-target": [
          "error",
          {
            allowedFiles: [
              // Explicit trust-boundary clients whose runtime origins come
              // from validated operator configuration, an exact issuer
              // allowlist, or Stella-owned presigned/reservation producers.
              // Arbitrary internet URLs belong behind safeOutboundFetch*.
              "apps/api/src/agent-auth/id-jag.ts",
              "apps/api/src/handlers/case-law/ingestion/adapters/pagination.ts",
              "apps/api/src/handlers/case-law/ingestion/adapters/retry.ts",
              // These wrappers restrict every target to exact Austrian
              // publisher origins and paths, then force redirect rejection.
              "apps/api/src/handlers/case-law/ingestion/adapters/at-findok-throttle.ts",
              "apps/api/src/handlers/case-law/ingestion/adapters/at-ris-throttle.ts",
              "apps/api/src/handlers/case-law/ingestion/adapters/cz-us.ts",
              "apps/api/src/handlers/case-law/ingestion/adapters/eu-ecj.ts",
              "apps/api/src/handlers/sharepoint/graph-oauth.ts",
              "apps/api/src/lib/deepl/client.ts",
              "apps/api/src/lib/document-processing-provider.ts",
              "apps/api/src/lib/files/gotenberg.ts",
              // This probe reaches only the operator-configured Gotenberg
              // deployment; no request or persisted data selects the origin.
              "apps/api/src/lib/health/probe-document-converter.ts",
              "apps/api/src/lib/hosted-usage-provider/client.ts",
              "apps/api/src/lib/legal-search/corpus-index-client.ts",
              "apps/api/src/lib/s3.ts",
              "apps/api/src/mcp/document-file-upload.ts",
              "apps/api/src/scripts/citation-probe.ts",
              "apps/api/src/scripts/mcp-canary.ts",
              "apps/api/src/scripts/post-deploy-smoke.ts",
            ],
          },
        ],
      },
    },
    {
      files: [
        "apps/api/src/**/*.test.ts",
        "apps/api/src/tests/**/*.ts",
        "apps/api/src/**/test-utils.ts",
        "apps/api/src/mcp/apps/**/*.{ts,tsx}",
      ],
      rules: {
        "require-safe-outbound-target/require-safe-outbound-target": "off",
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
              noZodImport,
              apiSafeIdBrandingImport,
              apiPortableSafeIdBrandingImport,
            ],
          },
        ],
      },
    },
    {
      // The legal-atlas-runner daemons are long-lived: an un-timed-out DB
      // await on a connection the server reaped silently hangs forever and
      // wedges the worker until external supervision restarts it.
      // All DB access must go through the timeout-wrapped handles in
      // apps/legal-atlas-runner/src/db.ts so no caller can build an unbounded
      // handle. That module is the only sanctioned importer of the raw pools.
      files: ["apps/legal-atlas-runner/**/*.ts"],
      excludeFiles: [
        "apps/legal-atlas-runner/src/db.ts",
        "apps/legal-atlas-runner/**/*.test.ts",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              noZodImport,
              {
                name: "@/api/db/root",
                message:
                  "Import timeout-wrapped DB handles from '../db' instead of the raw Bun SQL pools.",
              },
              {
                name: "@/api/db",
                importNames: ["createIngestionDb", "createScopedDb"],
                message:
                  "Import the timeout-wrapped `ingestionDb` from '../db' instead of building a raw handle.",
              },
            ],
          },
        ],
      },
    },
    {
      // The sanctioned branding boundaries: each validates a raw id and hands
      // back a SafeId, so these are the modules `toSafeId` exists for. Only
      // that restriction is lifted; the rest of the base set still applies.
      files: [
        "apps/api/src/lib/auth.ts",
        "apps/api/src/lib/search/**",
        "apps/api/src/lib/safe-id-boundaries.ts",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          { paths: [noZodImport, apiPortableSafeIdBrandingImport] },
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
      // @stll/business-registries subpath types resolve as error in
      // type-aware linting because the workspace package dist isn't
      // always available during local lint runs.
      files: [
        "apps/api/src/handlers/contacts/business-registries-lookup.ts",
        "apps/api/src/handlers/chat/tools/ares-tools.ts",
      ],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-call": "off",
      },
    },
    {
      files: ["apps/api/**/*.ts"],
      excludeFiles: [
        // These are the only low-level documents-bucket writers: they own
        // abort signals and tenant-scoped signing, which the retry helper
        // intentionally cannot provide.
        "apps/api/src/lib/s3.ts",
        "apps/api/src/lib/s3-presign.ts",
      ],
      rules: {
        "no-crypto-random-uuid/no-crypto-random-uuid": "error",
        "no-native-s3-object-read/no-native-s3-object-read": "error",
        "no-native-s3-object-write/no-native-s3-object-write": "error",
      },
    },
    {
      // A queue worker's `error` event fires once per failed poll, so an
      // unthrottled sink turns a Valkey disruption into an unbounded run of
      // identical lines. `createQueueWorkerErrorLogger` bounds it, and the
      // bound holds only while every handler goes through it: the call sites
      // are plain callbacks, so nothing but a rule can enforce that.
      files: [
        "apps/api/src/**/*.ts",
        ".oxlint-plugins/__fixtures__/queue-worker-error-sink.fixture.ts",
      ],
      rules: {
        "queue-worker-error-sink/queue-worker-error-sink": "error",
      },
    },
    {
      // Ownership as data: `scripts/ownership.ts` names the module that owns
      // each capability, and this rule confines the enforced rows to it. The
      // same table renders `docs/module-ownership.md`, so the enforced
      // boundary and the documented one cannot drift apart. A bypass is an
      // `allowed` entry with a reason in that file, which is also the review
      // record for what may now reach the capability.
      files: [
        "apps/api/src/**/*.ts",
        // The api's runnable evals and operational scripts reach the same
        // capabilities as `src` and ship the same defects when they bypass an
        // owner: an eval that read a moved chunk key scored every Anthropic
        // tool call as absent.
        "apps/api/evals/**/*.ts",
        "apps/api/scripts/**/*.ts",
        "apps/web/src/**/*.{ts,tsx}",
        // An owner that lives in a package (`@stll/clipboard`) confines
        // nothing if the rule stops at the apps: a second package could reach
        // the capability directly and no guard would say so.
        "packages/*/src/**/*.{ts,tsx}",
        // The landing's TypeScript: its `.astro` inline scripts stay outside
        // oxlint's reach (the `landing-inline-clipboard-writes` ratchet covers
        // those), but every module they import is linted here.
        "apps/landing/src/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/confine-owner.fixture.ts",
      ],
      excludeFiles: [
        "apps/api/src/**/*.test.ts",
        "apps/api/src/tests/**/*.ts",
        "apps/api/evals/**/*.test.ts",
        "apps/api/scripts/**/*.test.ts",
        "apps/web/src/**/*.test.{ts,tsx}",
        "packages/*/src/**/*.test.{ts,tsx}",
        "packages/*/src/**/tests/**/*.{ts,tsx}",
        "apps/landing/src/**/*.test.{ts,tsx}",
      ],
      rules: {
        "confine-owner/confine-owner": [
          "error",
          { entries: enforcedOwnershipEntries },
        ],
      },
    },
    {
      // Valkey key positions belong to `lib/redis-keys.ts`, which owns the
      // hashtag placement and the per-scope expiry policy. Tests are exempt so
      // a fixture can pin a produced key shape as a literal.
      files: [
        "apps/api/src/**/*.ts",
        ".oxlint-plugins/__fixtures__/require-coordination-key.fixture.ts",
      ],
      excludeFiles: ["apps/api/src/**/*.test.ts", "apps/api/src/tests/**/*.ts"],
      rules: {
        "require-coordination-key/require-coordination-key": "error",
      },
    },
    {
      // Module Side Effects (CLAUDE.md): known side-effecting singleton
      // constructors (DB pools, auth, Redis/queue connections, S3 clients)
      // must not run at module top level. Scoped to the backend and shared
      // packages, where these constructors are actually imported.
      files: [
        "apps/api/src/**/*.{ts,tsx}",
        "apps/legal-atlas-runner/src/**/*.{ts,tsx}",
        "packages/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-eager-singleton.fixture.ts",
      ],
      excludeFiles: [
        "apps/api/src/**/*.test.ts",
        "apps/api/src/tests/**/*.ts",
        "apps/legal-atlas-runner/src/**/*.test.ts",
        "packages/**/*.test.{ts,tsx}",
        "packages/**/__tests__/**/*.{ts,tsx}",
      ],
      rules: {
        "no-eager-singleton/no-eager-singleton": "error",
      },
    },
    {
      // Throw assertions must name the error they expect. Scoped to test
      // files (and the module-named fixture, which is not one) because
      // `expect(...).toThrow()` only appears there.
      files: [
        "**/*.test.{ts,tsx}",
        "**/*.property.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/__tests__/**/*.{ts,tsx}",
        "apps/api/src/tests/**/*.ts",
        ".oxlint-plugins/__fixtures__/no-vacuous-throw-assertion.fixture.ts",
      ],
      rules: {
        "no-vacuous-throw-assertion/no-vacuous-throw-assertion": "error",
      },
    },
    {
      // Module mocks of workspace modules test a fabricated dependency graph.
      // Scoped to test files and test helpers, where `mock.module` lives;
      // existing pairs are grandfathered in
      // scripts/internal-module-mock-ledger.json.
      files: [
        "**/*.test.{ts,tsx}",
        "**/*.property.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/__tests__/**/*.{ts,tsx}",
        "apps/*/src/tests/**/*.{ts,tsx}",
        ".oxlint-plugins/__fixtures__/no-internal-module-mock.fixture.ts",
      ],
      rules: {
        "no-internal-module-mock/no-internal-module-mock": "error",
      },
    },
    {
      // Canonical root DB module: constructs the process-wide root/RLS
      // connection pools and drizzle handles at import time by design —
      // it is the one designated singleton module every other DB access
      // path imports from, so there is no non-deterministic import-order
      // hazard to defer against. New singleton modules must use the lazy
      // `getX()` pattern instead of adding to this exemption.
      files: ["apps/api/src/db/root.ts"],
      rules: { "no-eager-singleton/no-eager-singleton": "off" },
    },
    {
      // Standalone CLI entrypoint (`bun run src/db/migrate.ts`), never
      // imported by other application modules, so eager construction here
      // carries no shared-import-order TDZ risk.
      files: ["apps/api/src/db/migrate.ts"],
      rules: { "no-eager-singleton/no-eager-singleton": "off" },
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
        "no-offset-pagination/no-offset-pagination": "error",
        "no-raw-user-id-schema/no-raw-user-id-schema": "error",
        "no-untyped-updates/no-untyped-updates": "error",
        "security-guards/no-unscoped-user-query": "error",
        "no-restricted-imports": [
          "error",
          {
            paths: [
              noZodImport,
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
              apiPortableSafeIdBrandingImport,
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
                importNames: ["rootDb", "rlsDb"],
                message:
                  "Handlers must not import owner-level DB values. Use ctx.scopedDb, or move owner-level DB access into a narrow lib helper.",
              },
            ],
          },
        ],
      },
    },
    {
      // Tests build handler context and owner-level DB handles directly: that
      // fixture surface is exactly what the handler restrictions keep out of
      // production code, so it is lifted here. The base set still applies.
      files: [
        "apps/api/src/tests/**",
        "apps/api/**/*.{test,spec}.{ts,tsx,js,jsx}",
        "apps/api/**/__tests__/**/*.{ts,tsx,js,jsx}",
      ],
      rules: {
        "no-restricted-imports": ["error", { paths: [noZodImport] }],
      },
    },
    {
      files: [
        "apps/api/src/handlers/**/routes.ts",
        "apps/api/src/handlers/**/*route.ts",
      ],
      rules: {
        "require-safe-route-handlers/require-safe-route-handlers": "error",
        "no-inline-endpoint-in-routes/no-inline-endpoint-in-routes": "error",
      },
    },
    {
      // Handler endpoint modules: a file-shaped schema must carry a transport
      // disposition on its config. Scoped to the handler tree because that is
      // where `satisfies HandlerConfig` lives; the capability exporter is the
      // total guard, including the schemas defined in a sibling module.
      files: ["apps/api/src/handlers/**/*.ts"],
      rules: {
        "require-file-transport-disposition/require-file-transport-disposition":
          "error",
      },
    },
    {
      // Grandfathered inline endpoint definitions (plan 046 Wave 0). These
      // route files define endpoints inline via createSafe*Handler; the rule is
      // enabled for new route files but these are not migrated in this pass.
      files: [
        "apps/api/src/handlers/case-law/routes.ts",
        "apps/api/src/handlers/files/routes.ts",
        "apps/api/src/handlers/search/routes.ts",
        "apps/api/src/handlers/time-entries/routes.ts",
        "apps/api/src/handlers/workspaces/routes.ts",
      ],
      rules: {
        "no-inline-endpoint-in-routes/no-inline-endpoint-in-routes": "off",
      },
    },
    {
      files: ["apps/api/src/handlers/**/public-routes.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              noZodImport,
              apiSafeIdBrandingImport,
              apiPortableSafeIdBrandingImport,
              {
                name: "@/api/lib/api-handlers",
                importNames: ["createHandler", "createRootHandler"],
                message:
                  "Use 'createSafeHandler' or 'createSafeRootHandler' instead.",
              },
              {
                name: "@/api/lib/api-handlers",
                importNames: ["createSafeHandler", "createSafeRootHandler"],
                message:
                  "Public route files must use createSafePublicHandler and must not receive authenticated handler context.",
              },
              {
                name: "@/api/lib/auth",
                message:
                  "Public route files must not import auth macros or permission helpers.",
              },
              {
                name: "@/api/db",
                message:
                  "Public route files must not import DB primitives. Use a narrow public-read helper.",
              },
              {
                name: "@/api/db/root",
                message:
                  "Public route files must not import root DB. Use a narrow public-read helper.",
              },
            ],
          },
        ],
      },
    },
    {
      files: [
        "apps/api/src/handlers/case-law/decisions/list.ts",
        "apps/api/src/handlers/case-law/decisions/get.ts",
        "apps/api/src/handlers/case-law/decisions/search.ts",
        "apps/api/src/handlers/case-law/decisions/sitemap.ts",
        "apps/api/src/lib/case-law-public-read-db.ts",
      ],
      rules: {
        "public-case-law-db-boundary/public-case-law-db-boundary": "error",
      },
    },
    {
      files: ["apps/api/src/handlers/case-law/decisions/search.ts"],
      rules: {
        "public-law-read-boundary/require-language-alternate-counts": "error",
      },
    },
    {
      files: ["apps/api/src/lib/public-law-read-db.ts"],
      rules: {
        "public-law-read-boundary/require-configured-read-transaction": "error",
      },
    },
    {
      // Explicit route-boundary exceptions: public/protocol/auth/dev/SSE
      // surfaces do not fit the normal safe-handler endpoint shape.
      files: [
        "apps/api/src/handlers/agent-auth/routes.ts",
        "apps/api/src/handlers/ai-config/routes.ts",
        "apps/api/src/handlers/auth/routes.ts",
        "apps/api/src/handlers/auth/ui-routes.ts",
        "apps/api/src/handlers/dev/routes.ts",
        "apps/api/src/handlers/entities/desktop-edit-sessions-route.ts",
        "apps/api/src/handlers/feedback/routes.ts",
        "apps/api/src/handlers/folio-collab/routes.ts",
        "apps/api/src/handlers/health/routes.ts",
        "apps/api/src/handlers/mcp/routes.ts",
        "apps/api/src/handlers/mcp-app-sandbox/routes.ts",
        "apps/api/src/handlers/mcp-connectors/oauth-client-metadata-route.ts",
        "apps/api/src/handlers/hosted-usage-webhook/routes.ts",
        "apps/api/src/handlers/notifications/routes.ts",
        "apps/api/src/handlers/smoke/routes.ts",
        "apps/api/src/handlers/verify/routes.ts",
        "apps/api/src/handlers/well-known/routes.ts",
        "apps/api/src/handlers/workspaces/events.ts",
      ],
      rules: {
        "require-safe-route-handlers/require-safe-route-handlers": "off",
      },
    },
    {
      // Agent-auth control-plane handlers write through rootDb (which bypasses
      // RLS), so their safe-handler generators have no safeDb Result to
      // `yield*`. They stay `async function*` to satisfy the
      // createSafeRootHandler contract, so require-yield does not apply.
      files: ["apps/api/src/handlers/agent-auth/**/*.ts"],
      rules: {
        "require-yield": "off",
      },
    },
    {
      files: ["apps/api/src/handlers/search/search.ts"],
      rules: { "no-body-ownership-ids/no-body-ownership-ids": "off" },
    },
    {
      files: ["apps/api/src/lib/docx/**/*.ts"],
      rules: {
        "no-untyped-updates/no-untyped-updates": "off",
        "unicorn/prefer-modern-dom-apis": "off",
        "unicorn/prefer-dom-node-remove": "off",
        "unicorn/prefer-dom-node-append": "off",
      },
    },
    {
      // The fixture deliberately asserts open inputs into closed contracts to
      // exercise the justification rule. Native assertion diagnostics would
      // duplicate those expected violations rather than test this detector.
      files: [
        ".oxlint-plugins/__fixtures__/no-unjustified-double-assertion.fixture.ts",
      ],
      rules: {
        "typescript/no-unsafe-type-assertion": "off",
        "typescript/no-unnecessary-type-assertion": "off",
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
        "typescript/require-await": "off",
        "require-yield": "off",
        "typescript/unbound-method": "off",
        "no-bare-error/no-bare-error": "off",
        "no-body-ownership-ids/no-body-ownership-ids": "off",
        "no-raw-user-id-schema/no-raw-user-id-schema": "off",
        "no-untyped-updates/no-untyped-updates": "off",
        "no-unbranded-ownership-id-param/no-unbranded-ownership-id-param":
          "off",
        "no-unjustified-double-assertion/no-unjustified-double-assertion":
          "off",
        "no-raw-colors/no-raw-colors": "off",
        "no-physical-properties/no-physical-properties": "off",
        "require-safe-route-handlers/require-safe-route-handlers": "off",
        "security-guards/no-raw-filename-write": "off",
        "security-guards/no-unsanitized-href": "off",
        "security-guards/no-unscoped-user-query": "off",
        "vitest/no-focused-tests": "error",
        "vitest/prefer-importing-vitest-globals": "off",
        // bun:test globals (describe/test/expect/it/…) can resolve as `error`
        // when test files are excluded from a package's main tsconfig.
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
      // better-result boundary lint, part 1: enable on directories already
      // at zero violations.
      //
      // AGENTS.md mandates better-result Result types over throw/try-catch
      // outside explicit boundary modules. The non-boundary scope is
      // apps/api/src/lib/**, apps/api/src/handlers/**, apps/api/src/mcp/**,
      // apps/web/src/**, and packages/*/src/** minus the boundary list in the
      // next override.
      //
      // That scope holds far more throw sites and try/catch blocks than one
      // change can convert, so enabling both rules across the whole scope
      // would break CI outright. The list lives in
      // scripts/result-boundary-globs.ts and names the exact directories that
      // already have zero violations of both rules; every other in-scope
      // directory stays unlisted (rules default to off) until the
      // `throw-outside-boundary` and `try-catch-outside-boundary` ratchet
      // counters in scripts/ratchet.ts walk it to zero, at which point it
      // moves into the list. scripts/check-result-boundary-enrolment.ts makes
      // that move the default: an unlisted directory has to carry a written
      // opt-out reason.
      files: [...RESULT_CONVENTION_ENABLED_GLOBS],
      rules: {
        "no-throw-outside-boundary/no-throw-outside-boundary": "error",
        "no-try-catch-outside-boundary/no-try-catch-outside-boundary": "error",
      },
    },
    {
      // better-result boundary lint, part 2: the boundary carve-out.
      //
      // These modules legitimately throw or catch: framework route mounts,
      // queue/worker entry points that must convert an uncaught exception
      // into a job failure, scripts run outside the request lifecycle, and
      // generated/test/fixture files. Scoped narrower than the enable list
      // above so it wins even for a boundary file that lives inside an
      // otherwise-enabled directory (e.g. a `routes.ts` under a clean
      // handler directory).
      files: [...RESULT_CONVENTION_EXCLUDE_GLOBS],
      rules: {
        "no-throw-outside-boundary/no-throw-outside-boundary": "off",
        "no-try-catch-outside-boundary/no-try-catch-outside-boundary": "off",
      },
    },
    {
      // @stll/cli is published to npm and must run under plain Node: the `Bun`
      // global is undefined there, so any `Bun.*` use in shipped source is a
      // runtime crash (Bun itself runs `node:*` natively, so the dev workflow
      // is unaffected). Ban the global in source that lands in `dist`; test
      // files run only under `bun test` and may use it.
      files: ["packages/cli/src/**/*.{ts,tsx}"],
      excludeFiles: ["packages/cli/src/**/*.test.ts"],
      rules: {
        "no-restricted-globals": [
          "error",
          {
            name: "Bun",
            message:
              "@stll/cli is published to npm and must run under plain Node; use node:* APIs (node:fs/promises, node:crypto, node:http, node:child_process) instead of the Bun global.",
          },
        ],
      },
    },
    {
      // Bare localeCompare is locale-nondeterministic (runtime default) and
      // rebuilds ICU tailoring per call; route through the cached collation
      // helper. Scoped to apps/web, apps/api and the helper's own package,
      // where the one legitimate bare call lives.
      files: [
        "apps/web/src/**/*.{ts,tsx}",
        "apps/api/src/**/*.ts",
        "packages/collation/src/**/*.ts",
        ".oxlint-plugins/__fixtures__/require-cached-collator.fixture.ts",
      ],
      rules: {
        "require-cached-collator/require-cached-collator": [
          "error",
          {
            allowedFiles: ["packages/collation/src/collation.ts"],
          },
        ],
      },
    },
    ...fixtureRuleOverrides,
  ],
});
