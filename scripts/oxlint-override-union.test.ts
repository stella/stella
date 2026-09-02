// Guard: an oxlint override must not silently drop an inherited restriction.
//
// Oxlint resolves `overrides` by replacement, not by merge: for a given file
// the last override that mentions a rule supplies that rule's entire
// configuration, and everything the base rule or an earlier matching override
// configured is discarded. For a severity-only rule that is harmless. For a
// rule whose configuration is a *list of restrictions* (`no-restricted-imports`
// and friends) it silently deletes bans, and nothing fails: the forbidden
// import simply stops being reported.
//
// This guard resolves every tracked rule against the real repository file list
// exactly the way oxlint does, then compares the effective restriction set of
// each file with the union of every restriction that matched it. A missing
// entry has to be listed in DELIBERATE_NARROWINGS with a reason, so narrowing a
// scope stays possible but never accidental.

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import config from "../oxlint.config.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const LINTED_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/u;

// Rules whose configuration is a list of restrictions rather than a knob, so a
// narrower scope is expected to inherit what a broader scope already forbids.
// A `no-restricted-*` rule configured with options anywhere in the config but
// missing here fails the totality test below.
const TRACKED_RULES = [
  "no-restricted-imports",
  "no-restricted-globals",
  "no-restricted-properties",
] as const;

type UnionRule = (typeof TRACKED_RULES)[number];

// Restrictions a scope drops on purpose. `scope` is the override's `files`
// list joined with ", "; `drops` are the entry keys the guard reports. An
// entry that no longer drops anything fails too, so the table cannot rot.
const DELIBERATE_NARROWINGS = [
  {
    rule: "no-restricted-imports",
    scope: "apps/web/src/components/date-picker-popover.tsx",
    drops: [
      "pattern:@stll/ui/date-picker-popover|@stll/ui/components/date-picker-popover",
    ],
    reason:
      "This file is the locale-injecting wrapper around the UI primitive, so it is the one web module that has to import it.",
  },
  {
    rule: "no-restricted-imports",
    scope:
      "apps/api/src/lib/auth.ts, apps/api/src/lib/search/**, apps/api/src/lib/safe-id-boundaries.ts",
    drops: ["path:@/api/lib/branded-types#toSafeId"],
    reason:
      "These are the sanctioned branding boundaries: they validate a raw id and hand back a SafeId, so they are the modules toSafeId exists for.",
  },
  {
    rule: "no-restricted-imports",
    scope:
      "apps/api/src/tests/**, apps/api/**/*.{test,spec}.{ts,tsx,js,jsx}, apps/api/**/__tests__/**/*.{ts,tsx,js,jsx}",
    drops: [
      "path:@/api/db#createSafeDb",
      "path:@/api/db#createScopedDb",
      "path:@/api/db#db",
      "path:@/api/db/root#rlsDb,rootDb",
      "path:@/api/lib/api-handlers#createHandler,createRootHandler",
      "path:@/api/lib/branded-types#toSafeId",
      "path:@stll/api-contract/safe-id#toSafeId",
    ],
    reason:
      "Tests build handler context and owner-level DB handles directly; that is the fixture surface the production restrictions exist to keep out of handlers.",
  },
  {
    rule: "no-restricted-imports",
    scope:
      "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/kanban/use-kanban-drop-targets.ts",
    drops: [
      "path:@atlaskit/pragmatic-drag-and-drop/element/adapter#draggable,dropTargetForElements",
    ],
    reason:
      "This is the web kanban drag-and-drop owner: the one module that may call the adapter's draggable/dropTargetForElements directly, behind its conflict-guarded attachElementDropTarget.",
  },
  {
    rule: "no-restricted-imports",
    scope: "packages/ui/src/kanban/drag-interactions.ts",
    drops: [
      "path:@atlaskit/pragmatic-drag-and-drop/element/adapter#draggable,dropTargetForElements",
    ],
    reason:
      "This is the @stll/ui kanban drag-and-drop owner: the one module that may call the adapter's draggable/dropTargetForElements directly.",
  },
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const readString = (source: Record<string, unknown>, key: string) => {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
};

/** `["error", …options]` → the options; anything else → no options. */
const ruleOptions = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.slice(1) : [];

const ruleIsOff = (value: unknown) => {
  const severity = Array.isArray(value) ? value[0] : value;
  return severity === "off" || severity === 0;
};

const pathKey = (name: string, importNames: string[]) =>
  importNames.length === 0
    ? `path:${name}`
    : `path:${name}#${[...importNames].sort((a, b) => a.localeCompare(b)).join(",")}`;

/**
 * Fields the comparison keys above account for. `message` carries no
 * enforcement, so it is known and ignored.
 *
 * Anything else is a field that can change what an entry forbids while leaving
 * its key identical — `allowTypeImports` and `allowImportNames` weaken a ban
 * in place, `caseSensitive` and `importNamePattern` change what it matches — so
 * an override could relax an inherited restriction and still look like it
 * carries it. The guard fails closed on an unknown field rather than compare
 * on a key that no longer describes the entry: teach the key builder first.
 */
const KNOWN_PATH_FIELDS = new Set(["name", "importNames", "message"]);
const KNOWN_PATTERN_FIELDS = new Set(["group", "regex", "message"]);

const unhandledEntryFields: string[] = [];

const recordUnhandledFields = (
  entry: Record<string, unknown>,
  known: ReadonlySet<string>,
  shape: string,
) => {
  for (const field of Object.keys(entry)) {
    if (!known.has(field)) {
      unhandledEntryFields.push(`${shape}.${field}`);
    }
  }
};

const restrictedImportKeys = (options: unknown): string[] => {
  const keys: string[] = [];
  const collectPath = (entry: unknown) => {
    if (typeof entry === "string") {
      keys.push(pathKey(entry, []));
      return;
    }
    if (!isRecord(entry)) {
      return;
    }
    recordUnhandledFields(entry, KNOWN_PATH_FIELDS, "paths");
    const name = readString(entry, "name");
    if (name === undefined) {
      return;
    }
    keys.push(pathKey(name, stringArray(entry["importNames"])));
  };
  const collectPattern = (entry: unknown) => {
    if (typeof entry === "string") {
      keys.push(`pattern:${entry}`);
      return;
    }
    if (!isRecord(entry)) {
      return;
    }
    recordUnhandledFields(entry, KNOWN_PATTERN_FIELDS, "patterns");
    const group = stringArray(entry["group"]);
    if (group.length > 0) {
      keys.push(`pattern:${group.join("|")}`);
      return;
    }
    const regex = readString(entry, "regex");
    if (regex !== undefined) {
      keys.push(`regex:${regex}`);
    }
  };

  for (const option of ruleOptions(options)) {
    if (typeof option === "string") {
      collectPath(option);
      continue;
    }
    if (!isRecord(option)) {
      continue;
    }
    for (const entry of Array.isArray(option["paths"]) ? option["paths"] : []) {
      collectPath(entry);
    }
    for (const entry of Array.isArray(option["patterns"])
      ? option["patterns"]
      : []) {
      collectPattern(entry);
    }
  }
  return keys;
};

const restrictedGlobalKeys = (options: unknown): string[] => {
  const keys: string[] = [];
  for (const option of ruleOptions(options)) {
    if (typeof option === "string") {
      keys.push(`global:${option}`);
      continue;
    }
    if (!isRecord(option)) {
      continue;
    }
    const name = readString(option, "name");
    if (name !== undefined) {
      keys.push(`global:${name}`);
    }
  }
  return keys;
};

const KNOWN_PROPERTY_FIELDS = new Set([
  "allowObjects",
  "allowProperties",
  "message",
  "object",
  "property",
]);

const restrictedPropertyKeys = (options: unknown): string[] => {
  const keys: string[] = [];
  for (const option of ruleOptions(options)) {
    if (!isRecord(option)) {
      continue;
    }
    recordUnhandledFields(option, KNOWN_PROPERTY_FIELDS, "properties");
    const object = readString(option, "object");
    const property = readString(option, "property");
    if (object !== undefined && property !== undefined) {
      keys.push(`property:${object}.${property}`);
      continue;
    }
    if (object !== undefined) {
      keys.push(
        `object:${object}#allow:${stringArray(option["allowProperties"]).sort().join(",")}`,
      );
      continue;
    }
    if (property !== undefined) {
      keys.push(
        `property:${property}#allow:${stringArray(option["allowObjects"]).sort().join(",")}`,
      );
    }
  }
  return keys;
};

// One stable key per restriction entry, per tracked rule.
const RESTRICTION_KEYS = {
  "no-restricted-imports": restrictedImportKeys,
  "no-restricted-globals": restrictedGlobalKeys,
  "no-restricted-properties": restrictedPropertyKeys,
} as const satisfies Record<UnionRule, (options: unknown) => string[]>;

// A whole-module ban subsumes an import-name-scoped ban on the same module:
// forbidding `@/api/db` outright already covers `@/api/db#db`.
const covers = (effective: ReadonlySet<string>, wanted: string) => {
  if (effective.has(wanted)) {
    return true;
  }
  const separator = wanted.indexOf("#");
  return separator > 0 && effective.has(wanted.slice(0, separator));
};

type ScopeConfig = {
  scope: string;
  files: string[];
  excludeFiles: string[];
  rules: Record<string, unknown>;
};

const readScopes = (root: unknown): ScopeConfig[] => {
  if (!isRecord(root)) {
    return [];
  }
  const scopes: ScopeConfig[] = [];
  const baseRules = root["rules"];
  if (isRecord(baseRules)) {
    scopes.push({
      scope: "<base>",
      files: ["**"],
      excludeFiles: [],
      rules: baseRules,
    });
  }
  const overrides = Array.isArray(root["overrides"]) ? root["overrides"] : [];
  for (const override of overrides) {
    if (!isRecord(override)) {
      continue;
    }
    const rules = override["rules"];
    if (!isRecord(rules)) {
      continue;
    }
    const files = stringArray(override["files"]);
    if (files.length === 0) {
      continue;
    }
    scopes.push({
      scope: files.join(", "),
      files,
      excludeFiles: stringArray(override["excludeFiles"]),
      rules,
    });
  }
  return scopes;
};

const globCache = new Map<string, Bun.Glob>();
const matches = (pattern: string, file: string) => {
  const cached = globCache.get(pattern) ?? new Bun.Glob(pattern);
  globCache.set(pattern, cached);
  return cached.match(file);
};

const scopeMatches = (scope: ScopeConfig, file: string) =>
  scope.files.some((pattern) => matches(pattern, file)) &&
  !scope.excludeFiles.some((pattern) => matches(pattern, file));

type Drop = { rule: string; scope: string; entry: string };

const dropKey = (drop: Drop) => `${drop.rule} | ${drop.scope} | ${drop.entry}`;

/**
 * Resolve `rule` the way oxlint does — last matching scope wins outright — and
 * report every restriction that some matching scope declared but the winning
 * scope does not carry.
 */
const findDrops = (
  root: unknown,
  files: readonly string[],
  rule: UnionRule,
): Drop[] => {
  const entryKeys = RESTRICTION_KEYS[rule];
  const scopes = readScopes(root).filter((scope) => rule in scope.rules);
  const drops = new Map<string, Drop>();

  for (const file of files) {
    const matching = scopes.filter((scope) => scopeMatches(scope, file));
    const winner = matching.at(-1);
    if (winner === undefined) {
      continue;
    }
    const effective = new Set(
      ruleIsOff(winner.rules[rule]) ? [] : entryKeys(winner.rules[rule]),
    );
    for (const scope of matching) {
      if (scope === winner) {
        continue;
      }
      for (const wanted of entryKeys(scope.rules[rule])) {
        if (covers(effective, wanted)) {
          continue;
        }
        const drop = { rule, scope: winner.scope, entry: wanted };
        drops.set(dropKey(drop), drop);
      }
    }
  }
  return [...drops.values()];
};

const lintedRepoFiles = () => {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: repoRoot });
  if (!result.success) {
    throw new Error("git ls-files failed; cannot resolve the override scopes");
  }
  const files = new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter((file) => LINTED_FILE_PATTERN.test(file));
  if (files.length === 0) {
    throw new Error("git ls-files returned no lintable files");
  }
  return files;
};

test("resolves overrides by replacement, last match first", () => {
  const synthetic = {
    rules: { "no-restricted-imports": ["error", { paths: ["base"] }] },
    overrides: [
      {
        files: ["src/**"],
        rules: { "no-restricted-imports": ["error", { paths: ["broad"] }] },
      },
      {
        files: ["src/narrow/**"],
        excludeFiles: ["src/narrow/exempt.ts"],
        rules: { "no-restricted-imports": ["error", { paths: ["narrow"] }] },
      },
    ],
  };

  expect(
    findDrops(synthetic, ["src/narrow/a.ts"], "no-restricted-imports").map(
      dropKey,
    ),
  ).toEqual([
    "no-restricted-imports | src/narrow/** | path:base",
    "no-restricted-imports | src/narrow/** | path:broad",
  ]);
  // excludeFiles hands the file back to the broader override, which still
  // drops the base entry.
  expect(
    findDrops(synthetic, ["src/narrow/exempt.ts"], "no-restricted-imports").map(
      dropKey,
    ),
  ).toEqual(["no-restricted-imports | src/** | path:base"]);
});

test("a whole-module ban subsumes an import-name ban on that module", () => {
  const synthetic = {
    rules: {},
    overrides: [
      {
        files: ["src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            { paths: [{ name: "@/db", importNames: ["rootDb"] }] },
          ],
        },
      },
      {
        files: ["src/public/**"],
        rules: {
          "no-restricted-imports": ["error", { paths: [{ name: "@/db" }] }],
        },
      },
    ],
  };

  expect(
    findDrops(synthetic, ["src/public/a.ts"], "no-restricted-imports"),
  ).toEqual([]);
});

test("every restriction-shaped rule with options is tracked", () => {
  const scopes = readScopes(config);
  const configured = new Set<string>();
  for (const scope of scopes) {
    for (const [rule, value] of Object.entries(scope.rules)) {
      if (!/(?:^|\/)no-restricted-/u.test(rule)) {
        continue;
      }
      if (ruleOptions(value).length === 0) {
        continue;
      }
      configured.add(rule);
    }
  }
  const sorted = (names: Iterable<string>) =>
    [...names].sort((a, b) => a.localeCompare(b));
  expect(sorted(configured)).toEqual(sorted(TRACKED_RULES));
});

test("override scopes that configure a tracked rule are uniquely named", () => {
  const scopes = readScopes(config);
  for (const rule of TRACKED_RULES) {
    const names = scopes
      .filter((scope) => rule in scope.rules)
      .map((scope) => scope.scope);
    expect(new Set(names).size).toBe(names.length);
  }
});

test("every restriction field is accounted for in the comparison key", () => {
  // Run the collectors over the whole config so every entry is visited, then
  // fail on any field the keys do not encode. Without this the guard compares
  // on a key that can describe two entries with different enforcement: an
  // override adding `allowTypeImports` or `allowImportNames` weakens an
  // inherited ban in place, and a key built from name and importNames alone
  // still matches, so the weakening reads as carrying the restriction.
  unhandledEntryFields.length = 0;
  for (const scope of readScopes(config)) {
    for (const rule of TRACKED_RULES) {
      RESTRICTION_KEYS[rule](scope.rules[rule]);
    }
  }

  expect([...new Set(unhandledEntryFields)].sort()).toEqual([]);
});

test("no override silently drops an inherited restriction", () => {
  const files = lintedRepoFiles();
  const observed = new Set<string>();
  for (const rule of TRACKED_RULES) {
    for (const drop of findDrops(config, files, rule)) {
      observed.add(dropKey(drop));
    }
  }

  const declared = new Set(
    DELIBERATE_NARROWINGS.flatMap(({ rule, scope, drops }) =>
      drops.map((entry) => dropKey({ rule, scope, entry })),
    ),
  );

  const sorted = (values: Iterable<string>) =>
    [...values].sort((a, b) => a.localeCompare(b));
  // Both directions: an undeclared drop is the bug this guard exists for, and
  // a declared drop that no longer happens means the table is stale.
  expect(sorted(observed)).toEqual(sorted(declared));
});
