// Declared and effective oxlint severities for the base (`**`) scope.
//
// The declared side merges the config the way oxlint 1.83 documents and
// implements it (crates/oxc_linter/src/config/config_builder.rs and
// oxlintrc.rs):
//   1. Plugins: the union of every config's `plugins` and oxlint's defaults
//      (typescript, unicorn, oxc).
//   2. Categories: `correctness` warns unless a config sets it; a category
//      applies to the built-in rules of enabled plugins.
//   3. Rules: an `extends` entry's own `extends` sit below it, later entries
//      sit above earlier ones, and the extending config sits above all of
//      them. Spellings of one rule (`complexity`, `eslint/complexity`) are
//      one rule.
// A rule named for a plugin no config enables stays declared: oxlint ignores
// it, which is a mismatch this guard exists to report.
//
// The effective side is `oxlint --print-config`, which prints the resolved
// base rules. Overrides are resolved per file at lint time and are not part
// of that output; the override union and liveness guards model them.

import { compareCodeUnit } from "@stll/collation";

import { isRecord, stringArray } from "./oxlint-config-scopes.ts";
import { pluginScope } from "./oxlint-rule-ids.ts";
import type { BuiltinRule } from "./oxlint-rule-ids.ts";

export const SEVERITY = {
  off: "off",
  warn: "warn",
  error: "error",
} as const;
type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

const SEVERITY_SPELLINGS: ReadonlyMap<unknown, Severity> = new Map<
  unknown,
  Severity
>([
  ["off", SEVERITY.off],
  ["allow", SEVERITY.off],
  [0, SEVERITY.off],
  ["warn", SEVERITY.warn],
  [1, SEVERITY.warn],
  ["error", SEVERITY.error],
  ["deny", SEVERITY.error],
  [2, SEVERITY.error],
]);

/** `"error"`, `["error", …options]`, `"deny"`, `2` → `error`. */
export const severityOf = (value: unknown): Severity | undefined =>
  SEVERITY_SPELLINGS.get(Array.isArray(value) ? value.at(0) : value);

const DEFAULT_PLUGINS = ["typescript", "unicorn", "oxc"] as const;
// ESLint core rules need no plugin entry in this repository's configs.
const ALWAYS_ENABLED_PLUGINS = ["eslint"] as const;
const DEFAULT_CATEGORIES = { correctness: SEVERITY.warn } as const;

export type RuleLayer = {
  /** Where the rules come from, for messages. */
  name: string;
  rules: Record<string, unknown>;
  plugins: string[];
  categories: Record<string, unknown>;
};

/** The config's `extends` chain and the config itself, lowest precedence first. */
export const flattenLayers = (config: unknown, name: string): RuleLayer[] => {
  if (!isRecord(config)) {
    return [];
  }
  const parents = Array.isArray(config["extends"]) ? config["extends"] : [];
  return [
    ...parents.flatMap((parent, index) =>
      flattenLayers(parent, `${name} > extends[${String(index)}]`),
    ),
    {
      name,
      rules: isRecord(config["rules"]) ? config["rules"] : {},
      plugins: stringArray(config["plugins"]),
      categories: isRecord(config["categories"]) ? config["categories"] : {},
    },
  ];
};

type Declaration = { severity: Severity; layer: string };

type DeclaredBaseRules = {
  /** Each rule's severity and the layer that set it. */
  rules: Map<string, Declaration>;
  /** The last rule-level severity a later layer replaced with another. */
  replaced: Map<string, Declaration>;
  /** One layer names a rule under several spellings with different values. */
  aliasConflicts: { rule: string; layer: string; keys: string[] }[];
  /** A key oxlint reads ambiguously, or a value with no severity. */
  invalidKeys: { key: string; layer: string; reason: InvalidKeyReason }[];
};

const INVALID_KEY_REASON = {
  ambiguousBare:
    "names no single built-in rule; oxlint assigns it to the first plugin with that rule name",
  typescriptAlias:
    "spells an ESLint rule under the typescript prefix; oxlint does not merge it with the ESLint spelling, so which one wins is undefined",
  noSeverity: "has no severity",
} as const;
type InvalidKeyReason =
  (typeof INVALID_KEY_REASON)[keyof typeof INVALID_KEY_REASON];

const TYPESCRIPT_PREFIXES = ["typescript/", "@typescript-eslint/"] as const;

type InvalidKeyOptions = {
  key: string;
  id: string;
  builtinIds: ReadonlySet<string>;
};

// Prefixed keys outside the built-in rules pass: JS plugins own theirs, and
// check-oxlint-rule-decisions owns typos under a built-in plugin.
const invalidKeyReason = ({
  key,
  id,
  builtinIds,
}: InvalidKeyOptions): InvalidKeyReason | undefined => {
  if (!id.includes("/")) {
    return INVALID_KEY_REASON.ambiguousBare;
  }
  if (
    id.startsWith("eslint/") &&
    TYPESCRIPT_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
    builtinIds.has(id)
  ) {
    return INVALID_KEY_REASON.typescriptAlias;
  }
  return undefined;
};

type DeclareOptions = {
  layers: readonly RuleLayer[];
  builtins: readonly BuiltinRule[];
  canonical: (key: string) => string;
};

const builtinId = (rule: BuiltinRule) => `${rule.scope}/${rule.value}`;

const categoryDefaults = ({
  layers,
  builtins,
}: Omit<DeclareOptions, "canonical">) => {
  const plugins = new Set(
    [
      ...ALWAYS_ENABLED_PLUGINS,
      ...DEFAULT_PLUGINS,
      ...layers.flatMap((layer) => layer.plugins),
    ].map(pluginScope),
  );
  const categories = new Map<string, Severity>(
    Object.entries(DEFAULT_CATEGORIES),
  );
  for (const layer of layers) {
    for (const [category, value] of Object.entries(layer.categories)) {
      const severity = severityOf(value);
      if (severity !== undefined) {
        categories.set(category, severity);
      }
    }
  }
  const rules = new Map<string, Declaration>();
  for (const rule of builtins) {
    const severity = categories.get(rule.category);
    if (severity !== undefined && plugins.has(rule.scope)) {
      rules.set(builtinId(rule), {
        severity,
        layer: `category ${rule.category}`,
      });
    }
  }
  return rules;
};

export const declaredBaseRules = ({
  layers,
  builtins,
  canonical,
}: DeclareOptions): DeclaredBaseRules => {
  const builtinIds = new Set(builtins.map(builtinId));
  const rules = categoryDefaults({ layers, builtins });
  const explicit = new Set<string>();
  const declared: DeclaredBaseRules = {
    rules,
    replaced: new Map(),
    aliasConflicts: [],
    invalidKeys: [],
  };
  for (const layer of layers) {
    const spellings = new Map<string, [string, unknown][]>();
    for (const [key, value] of Object.entries(layer.rules)) {
      const id = canonical(key);
      const reason = invalidKeyReason({ key, id, builtinIds });
      if (reason !== undefined) {
        declared.invalidKeys.push({ key, layer: layer.name, reason });
      } else if (builtinIds.has(id)) {
        const entries = spellings.get(id) ?? [];
        entries.push([key, value]);
        spellings.set(id, entries);
      }
    }
    for (const [id, entries] of spellings) {
      const values = new Set(entries.map(([, value]) => JSON.stringify(value)));
      const severity = severityOf(entries.at(0)?.[1]);
      if (values.size > 1) {
        declared.aliasConflicts.push({
          rule: id,
          layer: layer.name,
          keys: entries.map(([key]) => key),
        });
        rules.delete(id);
        continue;
      }
      if (severity === undefined) {
        declared.invalidKeys.push({
          key: entries.at(0)?.[0] ?? id,
          layer: layer.name,
          reason: INVALID_KEY_REASON.noSeverity,
        });
        continue;
      }
      const previous = rules.get(id);
      // Restating a severity keeps the layer that decided it.
      if (previous?.severity === severity) {
        explicit.add(id);
        continue;
      }
      if (previous !== undefined && explicit.has(id)) {
        declared.replaced.set(id, previous);
      }
      explicit.add(id);
      rules.set(id, { severity, layer: layer.name });
    }
  }
  return declared;
};

/** The base rules `oxlint --print-config` reports, keyed by canonical id. */
export const effectiveBaseRules = (
  printed: unknown,
  canonical: (key: string) => string,
): Map<string, Severity> | undefined => {
  if (!isRecord(printed) || !isRecord(printed["rules"])) {
    return undefined;
  }
  const rules = new Map<string, Severity>();
  for (const [key, value] of Object.entries(printed["rules"])) {
    const severity = severityOf(value);
    if (severity === undefined) {
      return undefined;
    }
    rules.set(canonical(key), severity);
  }
  return rules;
};

/** A rule whose severity changes between two points of the config. */
export type Finding = {
  rule: string;
  from: Severity;
  to: Severity;
  detail: string;
};

type CompareOptions = {
  declared: ReadonlyMap<string, Declaration>;
  effective: ReadonlyMap<string, Severity>;
  /** Rules whose declaration is already reported as ambiguous. */
  skip: ReadonlySet<string>;
};

/** Declared severity (`from`) against the one oxlint resolved (`to`). */
export const compareSeverities = ({
  declared,
  effective,
  skip,
}: CompareOptions): Finding[] => {
  const ids = new Set([...declared.keys(), ...effective.keys()]);
  const findings: Finding[] = [];
  for (const rule of [...ids].toSorted()) {
    const declaration = declared.get(rule);
    const from = declaration?.severity ?? SEVERITY.off;
    const to = effective.get(rule) ?? SEVERITY.off;
    if (!skip.has(rule) && from !== to) {
      findings.push({
        rule,
        from,
        to,
        detail: `declared by ${declaration?.layer ?? "nothing"}`,
      });
    }
  }
  return findings;
};

type ShadowOptions = {
  declared: Pick<DeclaredBaseRules, "rules" | "replaced">;
  /** The layer whose readers see its keys: the config file itself. */
  visibleLayer: string;
  /** Rules the visible layer names literally rather than through a spread. */
  visibleRules: ReadonlySet<string>;
};

/**
 * A preset severity (`from`) replaced by another layer's (`to`) that the
 * config file never states. Reading the preset then tells the wrong story.
 */
export const shadowedDeclarations = ({
  declared,
  visibleLayer,
  visibleRules,
}: ShadowOptions): Finding[] => {
  const findings: Finding[] = [];
  for (const [rule, replaced] of [...declared.replaced].toSorted(([a], [b]) =>
    compareCodeUnit(a, b),
  )) {
    const current = declared.rules.get(rule);
    if (
      current !== undefined &&
      current.layer !== visibleLayer &&
      !visibleRules.has(rule)
    ) {
      findings.push({
        rule,
        from: replaced.severity,
        to: current.severity,
        detail: `${replaced.layer} replaced by ${current.layer}`,
      });
    }
  }
  return findings;
};

export type BaselineEntry = { from: Severity; to: Severity; reason: string };

type BaselineVerdict = {
  /** Findings the baseline does not record with these severities. */
  unexpected: Finding[];
  /** Baseline entries that no longer describe a finding: delete them. */
  stale: string[];
};

export const checkBaseline = (
  findings: readonly Finding[],
  baseline: Readonly<Record<string, BaselineEntry>>,
): BaselineVerdict => {
  const matched = new Set<string>();
  const unexpected: Finding[] = [];
  for (const finding of findings) {
    const entry = baseline[finding.rule];
    if (entry?.from === finding.from && entry.to === finding.to) {
      matched.add(finding.rule);
    } else {
      unexpected.push(finding);
    }
  }
  const stale = Object.keys(baseline)
    .filter((rule) => !matched.has(rule))
    .toSorted();
  return { unexpected, stale };
};
