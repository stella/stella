// Built-in oxlint rules as the installed binary reports them, and one
// canonical id per config spelling (`no-non-null-assertion`,
// `typescript/no-non-null-assertion` and `@typescript-eslint/...` name the
// same rule).

import { panic } from "better-result";

import { isRecord } from "./oxlint-config-scopes.ts";

export type BuiltinRule = {
  scope: string;
  value: string;
  category: string;
};

export const builtinRules = (): BuiltinRule[] => {
  const result = Bun.spawnSync(
    ["bun", "--bun", "oxlint", "--rules", "-f", "json"],
    { cwd: import.meta.dir },
  );
  if (!result.success) {
    return panic("oxlint --rules failed; cannot resolve built-in rules");
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
  if (!Array.isArray(parsed)) {
    return panic("oxlint --rules returned an unexpected shape");
  }
  return parsed.filter(
    (rule): rule is BuiltinRule =>
      isRecord(rule) &&
      typeof rule["scope"] === "string" &&
      typeof rule["value"] === "string" &&
      typeof rule["category"] === "string",
  );
};

// Config spellings of a built-in plugin, keyed to the scope `--rules` reports.
const PLUGIN_ALIASES: Readonly<Record<string, string>> = {
  "@typescript-eslint": "typescript",
  "import-x": "import",
  "jsx-a11y": "jsx_a11y",
  n: "node",
  "react-perf": "react_perf",
};

export const pluginScope = (plugin: string) => PLUGIN_ALIASES[plugin] ?? plugin;

/** Resolves a config rule key to `scope/name`; JS-plugin keys pass through. */
export const ruleCanonicalizer = (rules: readonly BuiltinRule[]) => {
  const ids = new Set(rules.map((rule) => `${rule.scope}/${rule.value}`));
  const owners = new Map<string, string[]>();
  for (const rule of rules) {
    owners.set(rule.value, [
      ...(owners.get(rule.value) ?? []),
      `${rule.scope}/${rule.value}`,
    ]);
  }
  return (key: string): string => {
    const separator = key.lastIndexOf("/");
    if (separator === -1) {
      if (ids.has(`eslint/${key}`)) {
        return `eslint/${key}`;
      }
      const named = owners.get(key) ?? [];
      return named.length === 1 ? (named[0] ?? key) : key;
    }
    const id = `${pluginScope(key.slice(0, separator))}/${key.slice(separator + 1)}`;
    return ids.has(id) ? id : key;
  };
};
