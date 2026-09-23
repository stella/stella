// Design-system lint policy: the `@shadcn/lint` rules loaded through the
// Ultracite `shadcn` preset, plus the local rules whose debt is ratcheted
// beside them. Both `oxlint.config.ts` (the repository lint) and
// `oxlint.design.config.ts` (the rule-only pass the backlog guard runs) spread
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

const SHADCN_PLUGIN = "shadcn";

/**
 * The preset registers the plugin too; both configs declare it themselves so
 * dependency analysis reads the package off the config it inspects.
 */
export const SHADCN_LINT_JS_PLUGINS = [
  { name: SHADCN_PLUGIN, specifier: "@shadcn/lint" },
] satisfies ExternalPluginEntry[];

/** Rules whose merged-code debt is carried by `scripts/design-lint-baseline.json`. */
export const DESIGN_LINT_BACKLOG_RULES = [
  "shadcn/no-restyle",
  "shadcn/no-arbitrary-values",
  "no-raw-overflow-scroll/no-raw-overflow-scroll",
  "no-imported-class-constant/no-imported-class-constant",
] as const;

export type DesignLintBacklogRule = (typeof DESIGN_LINT_BACKLOG_RULES)[number];

/** Per rule, the files still carrying findings and how many each carries. */
export type DesignLintBacklog = Record<
  DesignLintBacklogRule,
  Record<string, number>
>;

const pluginOf = (rule: DesignLintBacklogRule): string =>
  rule.slice(0, rule.indexOf("/"));

const ruleOf = (rule: DesignLintBacklogRule): string =>
  rule.slice(rule.indexOf("/") + 1);

/**
 * `oxlint --format=json` names a finding `plugin(rule)`, for the external
 * shadcn plugin and a local module alike. Derived from the rule ids so the
 * report cannot be read against a different set than the one enabled.
 */
export const DESIGN_LINT_RULE_BY_DIAGNOSTIC_CODE: ReadonlyMap<
  string,
  DesignLintBacklogRule
> = new Map(
  DESIGN_LINT_BACKLOG_RULES.map(
    (rule) => [`${pluginOf(rule)}(${ruleOf(rule)})`, rule] as const,
  ),
);

/**
 * The plugins the baseline tracks. A diagnostic from one of them that is not
 * in the map above is a rule that was enabled without a ratchet decision, so
 * the guard fails on it rather than dropping it.
 */
export const DESIGN_LINT_TRACKED_PLUGINS: ReadonlySet<string> = new Set(
  DESIGN_LINT_BACKLOG_RULES.map(pluginOf),
);

const LOCAL_PLUGIN_PREFIX = "./.oxlint-plugins/";
const LOCAL_PLUGIN_SUFFIX = ".ts";

/**
 * A `jsPlugins` entry of `oxlint.config.ts` that carries a tracked local rule.
 * The design pass selects its plugins out of the repository config rather than
 * repeating the specifiers, so it can only load what the repository loads.
 */
export const isDesignLintLocalPlugin = (entry: unknown): entry is string =>
  typeof entry === "string" &&
  entry.startsWith(LOCAL_PLUGIN_PREFIX) &&
  entry.endsWith(LOCAL_PLUGIN_SUFFIX) &&
  DESIGN_LINT_TRACKED_PLUGINS.has(
    entry.slice(LOCAL_PLUGIN_PREFIX.length, -LOCAL_PLUGIN_SUFFIX.length),
  );

/** The tracked rules this repository implements, as opposed to the preset's. */
const DESIGN_LINT_LOCAL_RULES: ReadonlySet<string> = new Set(
  DESIGN_LINT_BACKLOG_RULES.filter((rule) => pluginOf(rule) !== SHADCN_PLUGIN),
);

/**
 * An `overrides` entry of `oxlint.config.ts` that switches a tracked local
 * rule on. The design pass reuses those scopes so it measures the files the
 * repository lint reads, no others. The severity is what separates a scope
 * from a backlog entry: `designLintBacklogOverrides` turns the same rules off
 * over the files this pass exists to re-measure.
 */
export const isDesignLintLocalRuleScope = (override: OxlintOverride): boolean =>
  Object.entries(override.rules ?? {}).some(
    ([rule, severity]) =>
      DESIGN_LINT_LOCAL_RULES.has(rule) && severity !== "off",
  );

export const SHADCN_LINT_RULES = {
  "shadcn/no-restyle": [
    "error",
    {
      allow: [
        "layout",
        // Reveal-on-hover: a row shows its actions when hovered or focused.
        // Whether a control is visible is the caller's concern, like `hidden`.
        "opacity-0",
        "opacity-100",
        "transition-opacity",
      ],
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
        // Cells carry their content's tone and alignment; a label its
        // weight. The table and label components own only the structure.
        {
          pattern: "^(?:TableCell|TableHead)$",
          allow: ["layout", "typography", "color"],
        },
        { pattern: "^Label$", allow: ["layout", "typography"] },
        // Layout containers: how their children stack is the caller's
        // layout, like the `flex-col` it sits next to.
        {
          pattern: "^(?:DialogPanel|FramePanel|Form|Field)$",
          allow: ["layout", "gap", "gap-x", "gap-y", "space-x", "space-y"],
        },
        // Code-shaped values (keys, identifiers) read in the monospace face.
        {
          pattern: "^(?:Input|InputGroupInput|SecretInput|Textarea)$",
          allow: ["layout", "font-mono"],
        },
      ],
    },
  ],
  "shadcn/no-arbitrary-values": [
    "error",
    {
      allow: [
        "layout",
        // The border-offset idiom DESIGN.md documents: inner spacing minus
        // the 1px border so content aligns with unbordered siblings.
        "*-[calc(--spacing(*)-1px)]",
        // The legal reader scales its type with a user setting.
        "text-[calc(*var(--reader-text-scale))]",
        // A CSS variable is a token reference, not a raw value.
        "*-[var(--*)]",
        // Transition property lists have no token form.
        "transition-[*]",
        "rounded-[inherit]",
        // Marker bar beside quoted or highlighted passages; no 3px step exists.
        "border-s-[3px]",
      ],
    },
  ],
  // Off: the tree hoists class constants and forwards `className` props
  // through wrappers by convention, which is all this rule can report.
  "shadcn/require-static-classes": "off",
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
    // Plugin fixtures are inputs for the local rules' tests, written to
    // trigger those rules; they are not product markup.
    files: [".oxlint-plugins/__fixtures__/**"],
    rules: {
      "shadcn/no-arbitrary-values": "off",
      "shadcn/no-raw-colors": "off",
      "shadcn/no-restyle": "off",
    },
  },
  {
    // The design-system components themselves: they restyle sibling
    // components and need structural arbitrary values. The preset's
    // `**/components/ui/**` override does not match this layout.
    files: ["packages/ui/src/components/**"],
    rules: {
      "shadcn/no-arbitrary-values": "off",
      "shadcn/no-restyle": "off",
    },
  },
  {
    // Pixel mockups of the product on the marketing site: miniature type,
    // clamp() sizes, and their own theme. Outside the design system.
    files: ["apps/landing/src/components/react/previews/**"],
    rules: { "shadcn/no-arbitrary-values": "off" },
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
 * What the measuring pass enables: the tracked shadcn rules under the same
 * options the repository lint uses, and nothing else from the preset. A
 * diagnostic the baseline script cannot map is then a rule that arrived
 * without a ratchet decision, which it reports instead of dropping. The two
 * local rules are scoped by file in `oxlint.config.ts`, and the design config
 * reuses those overrides, so they stay off at the top level here.
 */
export const DESIGN_LINT_MEASURED_RULES = {
  "shadcn/no-restyle": SHADCN_LINT_RULES["shadcn/no-restyle"],
  "shadcn/no-arbitrary-values": SHADCN_LINT_RULES["shadcn/no-arbitrary-values"],
  "shadcn/no-raw-colors": "off",
  "shadcn/no-inline-styles": "off",
  "shadcn/no-unknown-classes": "off",
  "shadcn/require-static-classes": "off",
  "no-raw-overflow-scroll/no-raw-overflow-scroll": "off",
  "no-imported-class-constant/no-imported-class-constant": "off",
} satisfies DummyRuleMap &
  Record<keyof typeof SHADCN_LINT_RULES, DummyRuleMap[string]>;

/**
 * One override per backlog rule switching it off in the files the baseline
 * still lists. `scripts/design-lint-baseline.ts --check` holds each file's
 * count at or below the baseline and prunes files that reach zero, so this
 * list only shrinks; a file outside it is linted in full. It is spread last
 * in `oxlint.config.ts`: oxlint resolves overrides by replacement, so a later
 * scope that enables a tracked rule would hand it back to a backlog file.
 */
export const designLintBacklogOverrides = (
  backlog: DesignLintBacklog,
): OxlintOverride[] =>
  DESIGN_LINT_BACKLOG_RULES.flatMap((rule) => {
    const files = Object.keys(backlog[rule]).toSorted();
    return files.length === 0 ? [] : [{ files, rules: { [rule]: "off" } }];
  });
