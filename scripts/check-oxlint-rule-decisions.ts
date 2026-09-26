// Fails when the installed oxlint ships a built-in rule that oxlint.config.ts
// never mentions, on or off, for a plugin the config enables. Oxlint turns on
// only a new rule's default category by itself, so without this check an
// upgrade can land rules nobody decided on. It also fails on a config key
// that names a built-in plugin but no rule in it (a typo or a removed rule),
// which oxlint would otherwise ignore. Every top-level rule the config turns
// off carries its reason in a comment directly above it.
//
// Usage: bun scripts/check-oxlint-rule-decisions.ts

import { readFileSync } from "node:fs";

import config from "../oxlint.config.ts";
import { isRecord, readScopes, stringArray } from "./oxlint-config-scopes.ts";
import {
  builtinRules,
  pluginScope,
  ruleCanonicalizer,
} from "./oxlint-rule-ids.ts";

// Plugins enabled for a subset of files only. Their rules are decided by
// oxlint's default category there rather than one by one.
const SCOPED_PLUGINS: Readonly<Record<string, string>> = {
  jest: "Test files only; oxlint's default correctness category applies.",
  vitest: "Test files only; oxlint's default correctness category applies.",
};

const NURSERY = "nursery";

const rules = builtinRules();
const canonical = ruleCanonicalizer(rules);
const builtinIds = new Set(rules.map((rule) => `${rule.scope}/${rule.value}`));
const builtinScopes = new Set(rules.map((rule) => rule.scope));

const presets = Array.isArray(config.extends)
  ? config.extends.filter(isRecord)
  : [];
const ruleMaps = [
  ...presets.flatMap((preset) => [
    isRecord(preset["rules"]) ? preset["rules"] : {},
    ...readScopes(preset).map((scope) => scope.rules),
  ]),
  ...readScopes(config).map((scope) => scope.rules),
];

const mentioned = new Set<string>();
const unknownKeys = new Set<string>();
for (const ruleMap of ruleMaps) {
  for (const key of Object.keys(ruleMap)) {
    const id = canonical(key);
    mentioned.add(id);
    const separator = id.lastIndexOf("/");
    const scope = separator === -1 ? "eslint" : id.slice(0, separator);
    if (builtinScopes.has(scope) && !builtinIds.has(id)) {
      unknownKeys.add(key);
    }
  }
}

const basePlugins = new Set(
  [
    "eslint",
    ...presets.flatMap((preset) => stringArray(preset["plugins"])),
  ].map(pluginScope),
);
const scopedPlugins = new Set(
  readScopes(config)
    .flatMap((scope) => scope.plugins)
    .map(pluginScope)
    .filter((plugin) => !basePlugins.has(plugin)),
);
const undeclaredScopedPlugins = [...scopedPlugins].filter(
  (plugin) => !(plugin in SCOPED_PLUGINS),
);
const staleScopedPlugins = Object.keys(SCOPED_PLUGINS).filter(
  (plugin) => !scopedPlugins.has(plugin),
);

const undecided = rules
  .filter(
    (rule) =>
      rule.category !== NURSERY &&
      basePlugins.has(rule.scope) &&
      !mentioned.has(`${rule.scope}/${rule.value}`),
  )
  .map((rule) => `${rule.scope}/${rule.value} (${rule.category})`)
  .toSorted();

const OFF_ENTRY = /^ {4}(?:"([^"]+)"|([\w-]+)): "off",$/u;
const configLines = readFileSync(
  new URL("../oxlint.config.ts", import.meta.url),
  "utf-8",
).split("\n");
const rulesStart = configLines.indexOf("  rules: {");
const rulesEnd = configLines.indexOf("  },", rulesStart);
const unexplainedOff: string[] = [];
for (let index = rulesStart + 1; index < rulesEnd; index++) {
  const match = OFF_ENTRY.exec(configLines[index] ?? "");
  if (!match) {
    continue;
  }
  if (!(configLines[index - 1] ?? "").trimStart().startsWith("//")) {
    unexplainedOff.push(
      `${match[1] ?? match[2] ?? ""} (line ${String(index + 1)})`,
    );
  }
}

const failures = [
  ...undecided.map((rule) => `built-in rule with no on/off decision: ${rule}`),
  ...unexplainedOff.map((rule) => `rule turned off without a reason: ${rule}`),
  ...[...unknownKeys]
    .toSorted()
    .map((key) => `config key names no built-in rule: ${key}`),
  ...undeclaredScopedPlugins.map(
    (plugin) =>
      `plugin enabled in an override but not declared in SCOPED_PLUGINS: ${plugin}`,
  ),
  ...staleScopedPlugins.map(
    (plugin) => `SCOPED_PLUGINS entry no override enables: ${plugin}`,
  ),
];

if (failures.length > 0) {
  process.stderr.write(
    `check-oxlint-rule-decisions: ${String(failures.length)} problem(s)\n${failures
      .map((failure) => `  ${failure}`)
      .join(
        "\n",
      )}\nDecide each rule in oxlint.config.ts ("error" or "off" with a reason).\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `check-oxlint-rule-decisions: every built-in rule of ${String(basePlugins.size)} plugins is decided\n`,
);
