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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { libraryIgnorePatterns, libraryOverrides } from "@stll/oxlint-config";

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
  SEVERITY,
  declaredBaseRules,
  flattenLayers,
} from "./oxlint-effective-config.ts";
import core from "./oxlint-presets/core.mjs";
import {
  builtinRules,
  pluginScope,
  ruleCanonicalizer,
} from "./oxlint-rule-ids.ts";
import validatorLedger from "./parser-validator-call-ledger.json" with { type: "json" };

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

    // What the presets declare, merged by the precedence the effective-config
    // guard checks against `oxlint --print-config`, so the two cannot disagree
    // on what a base entry replaces.
    const presetLayers = flattenLayers(config, "oxlint.config.ts").slice(0, -1);
    // JS plugin rules have no category or alias to resolve: the last preset
    // that names one decides it.
    const presetState = new Map([
      ...presetLayers.flatMap(({ rules: layerRules }) => [
        ...stateOf(layerRules),
      ]),
      ...[
        ...declaredBaseRules({
          layers: presetLayers,
          builtins: rules,
          canonical,
        }).rules,
      ].map(([id, { severity }]) => [id, severity !== SEVERITY.off] as const),
    ]);

    const noOps: string[] = [];
    const scopes = readScopes(config);
    const baseRules =
      scopes.find((scope) => scope.scope === BASE_SCOPE)?.rules ?? {};
    for (const [key, value] of Object.entries(baseRules)) {
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

test("the pre-commit autofix preserves includes checks", () => {
  const directory = mkdtempSync(
    nodePath.join(import.meta.dir, ".prefer-set-has-"),
  );
  const fixture = nodePath.join(directory, "fixture.ts");

  try {
    writeFileSync(
      fixture,
      [
        'const phrase = "alphabet".slice(0, 5);',
        'const names = ["alpha", "beta"];',
        "export const containsSubstring = (needle: string) => phrase.includes(needle);",
        "export const containsName = (name: string) => names.includes(name);",
      ].join("\n"),
    );

    const result = Bun.spawnSync(
      [
        process.execPath,
        "--bun",
        "oxlint",
        "-c",
        "oxlint.config.ts",
        "--fix",
        fixture,
      ],
      { cwd: nodePath.resolve(import.meta.dir, "..") },
    );

    const fixed = readFileSync(fixture, "utf-8");
    expect(fixed).toContain("phrase.includes(needle)");
    expect(fixed).toContain("names.includes(name)");
    expect(fixed).not.toContain("new Set(");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const PARSER_VALIDATOR_RULE_ID =
  "no-parser-validator-calls/no-parser-validator-calls";
const PARSER_VALIDATOR_LEDGER_PATH =
  "scripts/parser-validator-call-ledger.json";
const PARSER_VALIDATOR_REPO_ROOT = nodePath.resolve(import.meta.dir, "..");

const isParserValidatorGuarded = (file: string) => {
  let guarded = false;
  for (const scope of readScopes(config)) {
    if (
      !scope.files.some((glob) => new Bun.Glob(glob).match(file)) ||
      scope.excludeFiles.some((glob) => new Bun.Glob(glob).match(file))
    ) {
      continue;
    }
    if (PARSER_VALIDATOR_RULE_ID in scope.rules) {
      guarded = !ruleIsOff(scope.rules[PARSER_VALIDATOR_RULE_ID]);
    }
  }
  return guarded;
};

test("parser validation guard covers both parser trees and adapters, leaving the pipeline and oracle as owners", () => {
  for (const file of [
    "apps/api/src/handlers/case-law/ingestion/parsers/new-source.ts",
    "apps/api/src/handlers/case-law/ingestion/parsers/nested/new-source.ts",
    "apps/api/src/handlers/case-law/ingestion/adapters/new-source.ts",
    "apps/api/src/lib/legal-search/parsers/new-source.ts",
  ]) {
    expect(isParserValidatorGuarded(file)).toBe(true);
  }
  for (const file of [
    "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row.ts",
    "apps/api/src/lib/legal-search/parsers/validate-ast.ts",
    "apps/api/src/handlers/case-law/ingestion/parsers/new-source.test.ts",
    ".oxlint-plugins/__fixtures__/no-parser-validator-calls.fixture.pipeline.ts",
  ]) {
    expect(isParserValidatorGuarded(file)).toBe(false);
  }
});

test("validator ledger only removes entries from the target branch", () => {
  const exists = Bun.spawnSync(
    ["git", "cat-file", "-e", `origin/main:${PARSER_VALIDATOR_LEDGER_PATH}`],
    {
      cwd: PARSER_VALIDATOR_REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (exists.exitCode !== 0) {
    // The initial guard introduces the ledger; subsequent changes compare it
    // to main so removing debt cannot finance another legacy caller.
    const tree = Bun.spawnSync(
      ["git", "rev-parse", "--verify", "origin/main"],
      {
        cwd: PARSER_VALIDATOR_REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(tree.exitCode).toBe(0);
    return;
  }
  const previous = Bun.spawnSync(
    ["git", "show", `origin/main:${PARSER_VALIDATOR_LEDGER_PATH}`],
    {
      cwd: PARSER_VALIDATOR_REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(previous.exitCode).toBe(0);
  const parsed: unknown = JSON.parse(previous.stdout.toString());
  expect(Array.isArray(parsed)).toBe(true);
  if (!Array.isArray(parsed)) {
    return;
  }
  const allowed = new Set(parsed);
  expect(validatorLedger.filter((entry) => !allowed.has(entry))).toEqual([]);
});

test("legacy ledger entries remain scoped and point to existing source files", () => {
  expect(validatorLedger).toEqual([...new Set(validatorLedger)].toSorted());
  for (const entry of validatorLedger) {
    const file = entry.split("::").at(0);
    expect(file).toBeDefined();
    if (file === undefined) {
      continue;
    }
    expect(isParserValidatorGuarded(file)).toBe(true);
    expect(
      readFileSync(nodePath.join(PARSER_VALIDATOR_REPO_ROOT, file), "utf-8")
        .length,
    ).toBeGreaterThan(0);
  }
});
