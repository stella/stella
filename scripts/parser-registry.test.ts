import { expect, test } from "bun:test";
import { fail as panic } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { generateParserRegistry } from "./generate-parser-registry";
import {
  parseParserEntry,
  PARSER_ENTRY_DIRECTORY,
  PARSER_REGISTRY_NAMES as names,
  PARSER_REGISTRY_OUTPUT,
  renderParserRegistry,
} from "./parser-registry";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

const gitResult = (directory: string, args: string[]) =>
  Bun.spawnSync(["git", ...args], {
    cwd: directory,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Registry Test",
      GIT_AUTHOR_EMAIL: "registry@example.invalid",
      GIT_COMMITTER_NAME: "Registry Test",
      GIT_COMMITTER_EMAIL: "registry@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });

const git = (directory: string, args: string[]) => {
  const result = gitResult(directory, args);
  expect(
    result.exitCode,
    `${args.join(" ")}: ${result.stderr.toString()}`,
  ).toBe(0);
  return result.stdout.toString().trim();
};

const sourceEntries = (directory: string) =>
  new Map(
    readdirSync(path.join(directory, PARSER_ENTRY_DIRECTORY)).map((name) => {
      const file = `${PARSER_ENTRY_DIRECTORY}${name}`;
      return [file, readFileSync(path.join(directory, file), "utf-8")];
    }),
  );

const objectValue = (value: unknown) => {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Invalid parser registry value");
  }
  return value;
};

const expectedRegistry = (entries: ReadonlyMap<string, string>) => {
  const registry = {
    ADAPTER_KEYS: {},
    IMPORT_SOURCE_KEYS: {},
    PARSER_VERSIONS: {},
    SOURCE_FINGERPRINT_VERSIONS: {},
    PARSER_VERSION_SCOPES: {},
  } satisfies Record<(typeof names)[number], Record<string, unknown>>;
  for (const [file, source] of entries) {
    const entry = parseParserEntry({ file, source });
    const keyMap =
      entry.type === "parser" ? "ADAPTER_KEYS" : "IMPORT_SOURCE_KEYS";
    Reflect.set(registry[keyMap], entry.name, entry.key);
    Reflect.set(
      registry.SOURCE_FINGERPRINT_VERSIONS,
      entry.key,
      entry.sourceFingerprintVersion,
    );
    if (entry.type !== "parser") {
      continue;
    }
    Reflect.set(registry.PARSER_VERSIONS, entry.key, entry.parserVersion);
    Reflect.set(registry.PARSER_VERSION_SCOPES, entry.key, {
      version: entry.parserVersion,
      scope: entry.scope,
    });
  }
  return registry;
};

const loadRegistry = (directory: string) => {
  const script = `import * as registry from ${JSON.stringify(path.join(directory, PARSER_REGISTRY_OUTPUT))}; process.stdout.write(JSON.stringify(registry));`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: directory,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return objectValue(JSON.parse(result.stdout.toString()));
};

const assertRegistryMatchesEntries = (directory: string) => {
  const expected = expectedRegistry(sourceEntries(directory));
  const loaded = loadRegistry(directory);
  expect(loaded).toEqual(expected);
  return loaded;
};

const runGenerator = (directory: string, mode: "write" | "check" = "write") =>
  generateParserRegistry(pathToFileURL(`${directory}/`), mode);

const writeSourceEntries = (
  directory: string,
  entries: ReadonlyMap<string, string>,
) => {
  for (const [file, source] of entries) {
    const absolute = path.join(directory, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
};

const initializeRepository = (
  directory: string,
  entries: ReadonlyMap<string, string>,
) => {
  writeSourceEntries(directory, entries);
  mkdirSync(path.dirname(path.join(directory, PARSER_REGISTRY_OUTPUT)), {
    recursive: true,
  });
  git(directory, ["init", "--initial-branch=base"]);
  git(directory, ["add", PARSER_ENTRY_DIRECTORY]);
  git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", "entries"]);
  runGenerator(directory);
  git(directory, ["add", PARSER_REGISTRY_OUTPUT]);
  git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", "index"]);
};

test("canonical JSON entries define unique complete parser and import metadata", () => {
  const entries = sourceEntries(repositoryRoot);
  const parsed = [...entries].map(([file, source]) =>
    parseParserEntry({ file, source }),
  );
  const keys = parsed.map(({ key }) => key);
  const sourceNames = parsed.map(({ name }) => name);
  expect(new Set(keys).size).toBe(keys.length);
  expect(new Set(sourceNames).size).toBe(sourceNames.length);
  expect(renderParserRegistry(entries)).toBe(
    readFileSync(path.join(repositoryRoot, PARSER_REGISTRY_OUTPUT), "utf-8"),
  );
  assertRegistryMatchesEntries(repositoryRoot);
});

const bumpEntry = (file: string, source: string, side: string) => {
  const entry = parseParserEntry({ file, source });
  const bumped =
    entry.type === "parser"
      ? {
          ...entry,
          parserVersion: entry.parserVersion + 1,
          sourceFingerprintVersion: entry.sourceFingerprintVersion + 1,
          scope: { type: "all", reason: `Changed on ${side}.` },
        }
      : {
          ...entry,
          sourceFingerprintVersion: entry.sourceFingerprintVersion + 1,
        };
  return `${JSON.stringify(bumped)}\n`;
};

const render = (entries: ReadonlyMap<string, string>) =>
  renderParserRegistry(entries) ?? panic("Empty parser registry");

test("changes to neighbouring entries merge without a registry conflict", () => {
  const base = sourceEntries(repositoryRoot);
  const files = [...base.keys()].toSorted();
  const directory = mkdtempSync(path.join(tmpdir(), "parser-registry-merge-"));
  try {
    for (const [index, left] of files.slice(0, -1).entries()) {
      const right = files.at(index + 1) ?? panic("Missing neighbour entry");
      const leftSource = base.get(left) ?? panic(`Missing entry: ${left}`);
      const rightSource = base.get(right) ?? panic(`Missing entry: ${right}`);
      const ours = new Map(base).set(left, bumpEntry(left, leftSource, "ours"));
      const theirs = new Map(base).set(
        right,
        bumpEntry(right, rightSource, "theirs"),
      );
      const both = new Map(ours).set(
        right,
        bumpEntry(right, rightSource, "theirs"),
      );
      for (const [name, entries] of [
        ["base", base],
        ["ours", ours],
        ["theirs", theirs],
      ] as const) {
        writeFileSync(path.join(directory, name), render(entries));
      }
      const merged = gitResult(directory, [
        "merge-file",
        "-p",
        "ours",
        "base",
        "theirs",
      ]);
      expect(merged.exitCode, `${left} next to ${right}`).toBe(0);
      expect(merged.stdout.toString()).toBe(render(both));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("entry JSON schema rejects malformed and type-inconsistent records", () => {
  const file = `${PARSER_ENTRY_DIRECTORY}entry.json`;
  const invalidSources = [
    JSON.stringify({ type: "parser", name: "bad-name", key: "entry" }),
    JSON.stringify({
      type: "parser",
      name: "ENTRY",
      key: "wrong-path",
      parserVersion: 1,
      sourceFingerprintVersion: 0,
      scope: { type: "all", reason: "valid" },
    }),
    JSON.stringify({
      type: "parser",
      name: "ENTRY",
      key: "entry",
      parserVersion: 0,
      sourceFingerprintVersion: 0,
      scope: { type: "all", reason: "valid" },
    }),
    JSON.stringify({
      type: "parser",
      name: "ENTRY",
      key: "entry",
      parserVersion: 1,
      sourceFingerprintVersion: 0,
      scope: { type: "all", reason: " " },
    }),
    JSON.stringify({
      type: "import",
      name: "ENTRY",
      key: "entry",
      sourceFingerprintVersion: 0,
      parserVersion: 1,
    }),
  ];
  for (const source of invalidSources) {
    expect(() => parseParserEntry({ file, source })).toThrow(
      `Invalid parser registry entry: ${file}`,
    );
  }
  expect(() => parseParserEntry({ file, source: "{" })).toThrow(
    `Invalid parser registry JSON: ${file}`,
  );
});

test("entry sources exclusively own registry declarations", () => {
  for (const file of ["ingestion-constants.ts", "parser-reparse-scopes.ts"]) {
    const source = readFileSync(
      path.join(repositoryRoot, "apps/api/src/lib/legal-search", file),
      "utf-8",
    );
    for (const name of names) {
      expect(source).not.toMatch(
        new RegExp(`(?:const|let|var)\\s+${name}\\s*=`, "u"),
      );
    }
  }
});

test("generated index has no runtime imports after type erasure", () => {
  const source = readFileSync(
    path.join(repositoryRoot, PARSER_REGISTRY_OUTPUT),
    "utf-8",
  );
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  expect(transpiler.scanImports(transpiler.transformSync(source))).toEqual([]);
});

test("canonical JSON inventory includes new entries before Git staging", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "parser-registry-inventory-"),
  );
  try {
    writeSourceEntries(directory, sourceEntries(repositoryRoot));
    expect(existsSync(path.join(directory, ".git"))).toBe(false);
    runGenerator(directory);
    runGenerator(directory, "check");
    const added = {
      type: "parser",
      name: "TEMP_UNSTAGED",
      key: "temp-unstaged",
      parserVersion: 7,
      sourceFingerprintVersion: 0,
      scope: { type: "all", reason: "temporary source entry" },
    } as const;
    const addedPath = `${PARSER_ENTRY_DIRECTORY}${added.key}.json`;
    writeFileSync(
      path.join(directory, addedPath),
      `${JSON.stringify(added)}\n`,
    );
    expect(() => runGenerator(directory, "check")).toThrow(
      "Parser registry index is stale",
    );
    runGenerator(directory);
    const loaded = assertRegistryMatchesEntries(directory);
    expect(
      Reflect.get(
        objectValue(Reflect.get(loaded, "PARSER_VERSIONS")),
        added.key,
      ),
    ).toBe(added.parserVersion);
    runGenerator(directory, "check");
    const indexWithoutGit = readFileSync(
      path.join(directory, PARSER_REGISTRY_OUTPUT),
      "utf-8",
    );
    git(directory, ["init", "--initial-branch=inventory"]);
    git(directory, ["add", PARSER_ENTRY_DIRECTORY]);
    runGenerator(directory, "check");
    expect(
      readFileSync(path.join(directory, PARSER_REGISTRY_OUTPUT), "utf-8"),
    ).toBe(indexWithoutGit);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source inventory rejects non-JSON and unparsable entries with their paths", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "parser-registry-invalid-"),
  );
  try {
    writeSourceEntries(directory, sourceEntries(repositoryRoot));
    for (const name of ["notes.txt", "broken.json", "nested"]) {
      const file = `${PARSER_ENTRY_DIRECTORY}${name}`;
      const absolute = path.join(directory, file);
      if (name === "nested") {
        mkdirSync(absolute);
      } else {
        writeFileSync(absolute, "{");
      }
      expect(() => runGenerator(directory)).toThrow(file);
      rmSync(absolute, { recursive: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an empty entry set fails instead of emitting an empty index", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "parser-registry-empty-"));
  try {
    mkdirSync(path.join(directory, PARSER_ENTRY_DIRECTORY), {
      recursive: true,
    });
    expect(() => runGenerator(directory)).toThrow("No parser registry entries");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const operation of ["add", "bump"] as const) {
  test(`independent parser ${operation}s merge and regenerate both entries without fixtures`, () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "parser-registry-merge-"),
    );
    try {
      const originalEntries = sourceEntries(repositoryRoot);
      initializeRepository(directory, originalEntries);
      const original = assertRegistryMatchesEntries(directory);
      const originalVersions = objectValue(
        Reflect.get(original, "PARSER_VERSIONS"),
      );
      const expectedEntries = new Map(originalEntries);

      for (const [branch, existing, added] of [
        ["left", "cz-ns", "test-left"],
        ["right", "cz-us", "test-right"],
      ] as const) {
        git(directory, ["switch", "-c", branch, "base"]);
        const file = `${PARSER_ENTRY_DIRECTORY}${existing}.json`;
        const source = originalEntries.get(file);
        if (source === undefined) {
          throw new TypeError(`Missing canonical entry ${file}`);
        }
        const parsed = parseParserEntry({ file, source });
        if (parsed.type !== "parser") {
          throw new TypeError(`Expected parser entry ${file}`);
        }
        const updated =
          operation === "bump"
            ? {
                type: "parser" as const,
                name: parsed.name,
                key: parsed.key,
                sourceFingerprintVersion: parsed.sourceFingerprintVersion,
                parserVersion: parsed.parserVersion + 1,
                scope: parsed.scope,
              }
            : {
                type: "parser" as const,
                name: added.replaceAll("-", "_").toUpperCase(),
                key: added,
                sourceFingerprintVersion: 0,
                parserVersion: 1,
                scope: parsed.scope,
              };
        const target =
          operation === "bump"
            ? file
            : `${PARSER_ENTRY_DIRECTORY}${added}.json`;
        const next = `${JSON.stringify(updated, null, 2)}\n`;
        if (operation === "add") {
          expectedEntries.set(target, next);
        } else {
          expectedEntries.set(file, next);
        }
        writeFileSync(path.join(directory, target), next);
        git(directory, ["add", target]);
        runGenerator(directory);
        git(directory, ["add", PARSER_REGISTRY_OUTPUT]);
        git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", branch]);

        const changedFiles = git(directory, [
          "diff",
          "--name-only",
          "base",
          branch,
        ])
          .split("\n")
          .toSorted();
        expect(changedFiles).toEqual(
          [target, PARSER_REGISTRY_OUTPUT].toSorted(),
        );
        runGenerator(directory, "check");
        const loaded = assertRegistryMatchesEntries(directory);
        const versions = objectValue(Reflect.get(loaded, "PARSER_VERSIONS"));
        const versionKey = operation === "add" ? added : existing;
        const expectedVersion =
          operation === "add"
            ? 1
            : Number(Reflect.get(originalVersions, existing)) + 1;
        expect(Reflect.get(versions, versionKey)).toBe(expectedVersion);
      }

      const merge = gitResult(directory, [
        "merge-tree",
        "--write-tree",
        "left",
        "right",
      ]);
      const tree = merge.stdout.toString().split("\n").at(0);
      if (tree === undefined) {
        throw new TypeError("Missing merge tree");
      }
      const conflicts = [
        ...merge.stdout.toString().matchAll(/CONFLICT .* in (.+)$/gmu),
      ].map((match) => match[1]);
      const cleanMerge = merge.exitCode === 0 && conflicts.length === 0;
      const indexOnlyConflict =
        merge.exitCode === 1 &&
        conflicts.length > 0 &&
        conflicts.every((file) => file === PARSER_REGISTRY_OUTPUT);
      expect(cleanMerge || indexOnlyConflict).toBe(true);
      git(directory, ["read-tree", "--reset", "-u", tree]);
      runGenerator(directory);
      git(directory, ["add", PARSER_REGISTRY_OUTPUT]);
      git(directory, ["diff", "--check"]);
      git(directory, ["write-tree"]);
      runGenerator(directory, "check");
      expect(assertRegistryMatchesEntries(directory)).toEqual(
        expectedRegistry(expectedEntries),
      );

      const merged = loadRegistry(directory);
      const mergedVersions = objectValue(
        Reflect.get(merged, "PARSER_VERSIONS"),
      );
      if (operation === "add") {
        expect(Reflect.get(mergedVersions, "test-left")).toBe(1);
        expect(Reflect.get(mergedVersions, "test-right")).toBe(1);
      } else {
        expect(Reflect.get(mergedVersions, "cz-ns")).toBe(
          Number(Reflect.get(originalVersions, "cz-ns")) + 1,
        );
        expect(Reflect.get(mergedVersions, "cz-us")).toBe(
          Number(Reflect.get(originalVersions, "cz-us")) + 1,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
