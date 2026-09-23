// Guard: every scope in oxlint.config.ts has to reach a file, and every "off"
// has to turn something off.
//
// A glob that matches nothing (a renamed file, a literal `[.]` read as a
// character class) fails silently: the override applies to no file and the
// lint still passes. The same holds for a path in a rule option such as
// `allowedFiles`, and for a scope that switches off a rule no earlier scope
// enabled for any of its files. Each is dead configuration that reads as a
// decision, so this test fails on all three.

import { expect, test } from "bun:test";
import core from "ultracite/oxlint/core";

import {
  libraryIgnorePatterns,
  libraryOverrides,
  libraryRules,
} from "@stll/oxlint-config";

import config from "../oxlint.config.ts";
import {
  BASE_SCOPE,
  createFileIndex,
  isRecord,
  matches,
  readScopes,
  ruleIsOff,
  ruleOptions,
  stringArray,
  trackedRepoFiles,
} from "./oxlint-config-scopes.ts";
import {
  builtinRules,
  pluginScope,
  ruleCanonicalizer,
} from "./oxlint-rule-ids.ts";

const TIMEOUT_MS = 60_000;

// Overrides a third-party preset ships verbatim. Their globs describe other
// repositories' layouts, so they are not this config's to prune.
const vendoredOverrides = new Set<unknown>([
  ...(core.overrides ?? []),
  ...libraryOverrides,
]);

// Rules whose options hold module specifiers and messages, not repo paths.
const SPECIFIER_OPTION_RULES = new Set([
  "no-restricted-imports",
  "no-restricted-globals",
  "no-restricted-properties",
]);

const ignorePatterns = [
  ...libraryIgnorePatterns,
  ...stringArray(config.ignorePatterns),
];

const ignored = (file: string) =>
  ignorePatterns.some((pattern) =>
    pattern.endsWith("/")
      ? file.startsWith(pattern) || file.includes(`/${pattern}`)
      : matches(pattern, file),
  );

const fileIndex = createFileIndex(
  trackedRepoFiles().filter((file) => !ignored(file)),
);

const presets = (): Record<string, unknown>[] =>
  Array.isArray(config.extends) ? config.extends.filter(isRecord) : [];

test(
  "every override glob matches a linted file",
  () => {
    const dead: string[] = [];
    for (const scope of readScopes(config)) {
      if (scope.scope === BASE_SCOPE || vendoredOverrides.has(scope.source)) {
        continue;
      }
      const globs = [
        ...scope.files.map((pattern) => ["files", pattern] as const),
        ...scope.excludeFiles.map(
          (pattern) => ["excludeFiles", pattern] as const,
        ),
      ];
      for (const [key, pattern] of globs) {
        if (fileIndex.filesMatching(pattern).length === 0) {
          dead.push(`${key}: ${pattern}`);
        }
      }
    }

    expect([...new Set(dead)].toSorted()).toEqual([]);
  },
  TIMEOUT_MS,
);

const REPO_PATH = /^(?:apps|packages|scripts|\.oxlint-plugins|\.claude)\/\S+$/u;

const collectPaths = (value: unknown, found: Set<string>) => {
  if (typeof value === "string") {
    if (REPO_PATH.test(value)) {
      found.add(value);
    }
    return;
  }
  if (isRecord(value)) {
    collectPaths(Object.values(value), found);
    return;
  }
  for (const entry of Array.isArray(value) ? value : []) {
    collectPaths(entry, found);
  }
};

test(
  "every path a rule option names exists",
  () => {
    const found = new Set<string>();
    for (const scope of readScopes(config)) {
      for (const [rule, value] of Object.entries(scope.rules)) {
        if (!SPECIFIER_OPTION_RULES.has(rule)) {
          collectPaths(ruleOptions(value), found);
        }
      }
    }
    // A trailing slash names a directory: any file under it keeps it alive.
    const missing = [...found].filter((path) =>
      path.endsWith("/")
        ? fileIndex.filesMatching(`${path}**`).length === 0
        : fileIndex.filesMatching(path).length === 0,
    );

    expect(missing.toSorted()).toEqual([]);
  },
  TIMEOUT_MS,
);

test(
  "every off switches off a rule an earlier scope enables",
  () => {
    const rules = builtinRules();
    const canonical = ruleCanonicalizer(rules);
    // Oxlint enables the correctness category of every active plugin unless
    // the config says otherwise, so those rules count as enabled.
    const correctness = new Map<string, string[]>();
    for (const rule of rules) {
      if (rule.category === "correctness") {
        correctness.set(rule.scope, [
          ...(correctness.get(rule.scope) ?? []),
          `${rule.scope}/${rule.value}`,
        ]);
      }
    }
    const pluginDefaults = (plugins: readonly string[]) =>
      new Set(
        plugins.flatMap((plugin) => correctness.get(pluginScope(plugin)) ?? []),
      );
    const stateOf = (ruleMap: Record<string, unknown>) =>
      new Map(
        Object.entries(ruleMap).map(
          ([key, value]) => [canonical(key), !ruleIsOff(value)] as const,
        ),
      );

    const presetState = new Map<string, boolean>();
    for (const id of pluginDefaults([
      "eslint",
      ...presets().flatMap((preset) => stringArray(preset["plugins"])),
    ])) {
      presetState.set(id, true);
    }
    for (const preset of presets()) {
      for (const [id, enabled] of stateOf(
        isRecord(preset["rules"]) ? preset["rules"] : {},
      )) {
        presetState.set(id, enabled);
      }
    }

    const noOps: string[] = [];
    const scopes = readScopes(config);
    const baseRules =
      scopes.find((scope) => scope.scope === BASE_SCOPE)?.rules ?? {};
    const vendoredBase: Readonly<Record<string, unknown>> = libraryRules;
    for (const [key, value] of Object.entries(baseRules)) {
      // A base entry the shared library config ships is its decision.
      if (Bun.deepEquals(vendoredBase[key], value)) {
        continue;
      }
      if (ruleIsOff(value) && presetState.get(canonical(key)) !== true) {
        noOps.push(`${BASE_SCOPE} | ${key}`);
      }
    }
    const baseState = new Map([...presetState, ...stateOf(baseRules)]);

    const overrides = scopes
      .filter((scope) => scope.scope !== BASE_SCOPE)
      .map((scope) => ({
        scope,
        vendored: vendoredOverrides.has(scope.source),
        reached: fileIndex.scopeFiles(scope),
        state: stateOf(scope.rules),
        defaults: pluginDefaults(scope.plugins),
      }));

    // Resolve one rule for one file over the base and every earlier override
    // that reaches the file: the last scope that mentions the rule wins.
    const enabledBefore = (id: string, file: string, index: number) => {
      if (overrides[index]?.defaults.has(id) === true) {
        return true;
      }
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const candidate = overrides[earlier];
        if (candidate === undefined || !candidate.reached.has(file)) {
          continue;
        }
        const enabled = candidate.state.get(id);
        if (enabled !== undefined) {
          return enabled;
        }
        if (candidate.defaults.has(id)) {
          return true;
        }
      }
      return baseState.get(id) === true;
    };

    for (const [index, { scope, reached, vendored }] of overrides.entries()) {
      if (vendored) {
        continue;
      }
      for (const [key, value] of Object.entries(scope.rules)) {
        if (!ruleIsOff(value)) {
          continue;
        }
        const id = canonical(key);
        if (![...reached].some((file) => enabledBefore(id, file, index))) {
          noOps.push(`${scope.scope} | ${key}`);
        }
      }
    }

    expect([...new Set(noOps)].toSorted()).toEqual([]);
  },
  TIMEOUT_MS,
);
