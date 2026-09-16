// Design-system lint policy (`@shadcn/lint`, loaded through the Ultracite
// `shadcn` preset). Both `oxlint.config.ts` (the repository lint) and
// `oxlint.shadcn.config.ts` (the rule-only pass the backlog guard runs) spread
// these exports, so the policy cannot drift between the two.
//
// Three of the six upstream rules overlap guards this repository already
// enforces. Each overlap is resolved to one owner rather than blended:
//   no-unknown-classes → `tailwindcss/no-unknown-classes`. That rule resolves
//     the Tailwind entry point per workspace (`settings.tailwindcss`), while
//     the shadcn rule reads each package's `components.json` theme; the
//     `packages/ui` theme file declares tokens only, so every core utility
//     there reads as unknown.
//   no-inline-styles → `no-inline-style-colors`. Colour in `style` is the
//     defect; width, height, and transform values there are the dynamic
//     sizing path (virtualised lists, resizable panes) and stay allowed.
//   no-raw-colors (classes) → `no-raw-colors/no-raw-colors` from
//     `@stll/oxlint-config`. The shadcn rule keeps the SVG attribute surface
//     (`fill`, `stroke`, `stopColor`) that the class rule does not read.

import type { DummyRuleMap, ExternalPluginEntry, OxlintOverride } from "oxlint";

/**
 * The preset registers the plugin too; both configs declare it themselves so
 * dependency analysis reads the package off the config it inspects.
 */
export const SHADCN_LINT_JS_PLUGINS = [
  { name: "shadcn", specifier: "@shadcn/lint" },
] satisfies ExternalPluginEntry[];

/** Rules whose merged-code debt is carried by `scripts/shadcn-lint-baseline.json`. */
export const SHADCN_LINT_BACKLOG_RULES = [
  "shadcn/no-restyle",
  "shadcn/no-arbitrary-values",
  "shadcn/require-static-classes",
] as const;

export type ShadcnLintBacklogRule = (typeof SHADCN_LINT_BACKLOG_RULES)[number];

/** Per rule, the files still carrying findings and how many each carries. */
export type ShadcnLintBacklog = Record<
  ShadcnLintBacklogRule,
  Record<string, number>
>;

export const SHADCN_LINT_RULES = {
  "shadcn/no-restyle": [
    "error",
    {
      allow: ["layout"],
      contracts: [
        // Bidi isolation wrappers around caller text: the caller owns the
        // type and colour, the component owns only `unicode-bidi`.
        {
          pattern: "^(?:BidiText|UserText)$",
          allow: ["layout", "typography", "color"],
        },
        // A placeholder mirrors the shape of the content it stands in for.
        { pattern: "^Skeleton$", allow: ["layout", "shape"] },
        // RTL-flipping wrapper around an icon: the caller owns the icon's
        // colour and its transition (rotating chevrons).
        {
          pattern: "^DirectionalIcon$",
          allow: ["layout", "color", "motion"],
        },
      ],
    },
  ],
  "shadcn/no-arbitrary-values": ["error", { allow: ["layout"] }],
  "shadcn/require-static-classes": "error",
  // SVG attributes only: `deny: []` exempts every class, which
  // `no-raw-colors/no-raw-colors` owns, and leaves the attribute checks on.
  "shadcn/no-raw-colors": ["error", { deny: [] }],
  "shadcn/no-inline-styles": "off",
  "shadcn/no-unknown-classes": "off",
} satisfies DummyRuleMap;

export const SHADCN_LINT_SETTINGS = {
  note: "Design rules: DESIGN.md, Component Conventions.",
} as const;

export const SHADCN_LINT_POLICY_OVERRIDES = [
  {
    // The design-system components themselves: they restyle sibling
    // components, need structural arbitrary values, and pass their own
    // variant functions as class values. The preset's `**/components/ui/**`
    // override does not match this layout.
    files: ["packages/ui/src/components/**"],
    rules: {
      "shadcn/no-arbitrary-values": "off",
      "shadcn/no-restyle": "off",
      "shadcn/require-static-classes": "off",
    },
  },
  {
    // Third-party brand artwork (file-type, sign-in provider, AI provider,
    // and chat-client logos) is drawn in the owner's colours, not the theme's.
    files: [
      "apps/landing/src/components/react/previews/CliMcpPreview.tsx",
      "apps/web/src/components/ai-provider-icons.tsx",
      "apps/web/src/components/auth/sign-in-panel.tsx",
      "apps/web/src/components/document-icon.tsx",
    ],
    rules: { "shadcn/no-raw-colors": "off" },
  },
] as const satisfies readonly OxlintOverride[];

/**
 * One override per backlog rule switching it off in the files the baseline
 * still lists. `scripts/shadcn-lint-baseline.ts --check` holds each file's
 * count at or below the baseline and prunes files that reach zero, so this
 * list only shrinks; a file outside it is linted in full.
 */
export const shadcnBacklogOverrides = (
  backlog: ShadcnLintBacklog,
): OxlintOverride[] =>
  SHADCN_LINT_BACKLOG_RULES.flatMap((rule) => {
    const files = Object.keys(backlog[rule]).sort();
    return files.length === 0 ? [] : [{ files, rules: { [rule]: "off" } }];
  });
