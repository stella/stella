// Built-in oxlint rules as the installed binary reports them, and one
// canonical id per config spelling (`no-non-null-assertion`,
// `typescript/no-non-null-assertion` and `@typescript-eslint/...` name the
// same rule).

import { panic } from "better-result";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { childExitStatus } from "../packages/scripts/src/child-exit-status.ts";
import { isRecord } from "./oxlint-config-scopes.ts";

export type BuiltinRule = {
  scope: string;
  value: string;
  category: string;
};

export const builtinRules = (): BuiltinRule[] => {
  // The listing goes to a file: a piped stdout from the Node shim can be cut
  // short when the process exits before the pipe drains.
  const directory = mkdtempSync(path.join(tmpdir(), "oxlint-rules-"));
  const output = path.join(directory, "rules.json");
  // The catalog loads independently of the project config.
  const config = path.join(directory, "oxlint.config.json");
  writeFileSync(config, "{}");
  const descriptor = openSync(output, "w");
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../node_modules/oxlint/bin/oxlint", import.meta.url),
      ),
      "-c",
      config,
      "--rules",
      "-f",
      "json",
    ],
    { stdio: ["ignore", descriptor, "pipe"] },
  );
  closeSync(descriptor);
  const text =
    childExitStatus(result) === 0 ? readFileSync(output, "utf-8") : undefined;
  rmSync(directory, { recursive: true, force: true });
  if (text === undefined) {
    return panic("oxlint --rules failed; cannot resolve built-in rules");
  }
  const parsed: unknown = JSON.parse(text);
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
export const PLUGIN_ALIASES: Readonly<Record<string, string>> = {
  "@typescript-eslint": "typescript",
  "typescript-eslint": "typescript",
  "react-hooks": "react",
  "import-x": "import",
  "jsx-a11y": "jsx_a11y",
  n: "node",
  "react-perf": "react_perf",
};

export const pluginScope = (plugin: string) => PLUGIN_ALIASES[plugin] ?? plugin;

// ESLint core rules oxlint also accepts under the typescript prefix; it
// configures the ESLint rule for either spelling
// (crates/oxc_linter/src/utils/mod.rs, TYPESCRIPT_COMPATIBLE_ESLINT_RULES).
const TYPESCRIPT_ADAPTED_ESLINT_RULES: ReadonlySet<string> = new Set([
  "class-methods-use-this",
  "default-param-last",
  "init-declarations",
  "max-params",
  "no-array-constructor",
  "no-dupe-class-members",
  "no-empty-function",
  "no-invalid-this",
  "no-loop-func",
  "no-loss-of-precision",
  "no-magic-numbers",
  "no-redeclare",
  "no-restricted-imports",
  "no-shadow",
  "no-unused-expressions",
  "no-unused-vars",
  "no-use-before-define",
  "no-useless-constructor",
]);

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
    const scope = pluginScope(key.slice(0, separator));
    const name = key.slice(separator + 1);
    const id = `${scope}/${name}`;
    if (ids.has(id)) {
      return id;
    }
    return scope === "typescript" && TYPESCRIPT_ADAPTED_ESLINT_RULES.has(name)
      ? `eslint/${name}`
      : key;
  };
};
