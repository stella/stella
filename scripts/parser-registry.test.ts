import { expect, test } from "bun:test";
import {
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
  PARSER_ENTRY_DIRECTORY,
  PARSER_REGISTRY_NAMES as names,
  PARSER_REGISTRY_OUTPUT,
  renderParserRegistry,
} from "./parser-registry";

const root = path.resolve(import.meta.dirname, "..");
const registryDirectory = "apps/api/src/lib/legal-search/";
const fixturesDirectory = `${registryDirectory}__fixtures__/parser-registry/`;

const entrySources = () =>
  new Map(
    readdirSync(path.join(root, PARSER_ENTRY_DIRECTORY)).map((file) => [
      `${PARSER_ENTRY_DIRECTORY}${file}`,
      readFileSync(path.join(root, PARSER_ENTRY_DIRECTORY, file), "utf-8"),
    ]),
  );

const loadRegistry = (directory: string) => {
  const script = `import * as registry from ${JSON.stringify(path.join(directory, PARSER_REGISTRY_OUTPUT))}; process.stdout.write(JSON.stringify(registry));`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: directory,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const loaded: unknown = JSON.parse(result.stdout.toString());
  return loaded;
};

const renderedRegistry = (files: ReadonlyMap<string, string>) => {
  const rendered = renderParserRegistry(files);
  if (rendered === undefined) {
    throw new TypeError("No parser registry entries");
  }
  return rendered;
};

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Invalid parser registry");
  }
  return value;
};

test("loaded parser registry preserves the base commit's keys and values", () => {
  const expected = {
    ADAPTER_KEYS: {},
    IMPORT_SOURCE_KEYS: {},
    PARSER_VERSIONS: {},
    SOURCE_FINGERPRINT_VERSIONS: {},
    PARSER_VERSION_SCOPES: {},
  } satisfies Record<(typeof names)[number], Record<string, unknown>>;
  for (const file of readdirSync(path.join(root, fixturesDirectory))) {
    const fixture: unknown = JSON.parse(
      readFileSync(path.join(root, fixturesDirectory, file), "utf-8"),
    );
    expect(fixture).toBeObject();
    if (typeof fixture !== "object" || fixture === null) {
      throw new TypeError(`Invalid registry fixture: ${file}`);
    }
    for (const name of names) {
      Object.assign(expected[name], Reflect.get(fixture, name));
    }
  }
  const loaded = loadRegistry(root);
  expect(loaded).toEqual(expected);
});

test("generation reads regular TypeScript entry files only", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "parser-registry-files-"));
  try {
    const entries = entrySources();
    for (const [file, source] of entries) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), source);
    }
    writeFileSync(path.join(directory, "README.md"), "not a registry entry");
    writeFileSync(
      path.join(directory, PARSER_ENTRY_DIRECTORY, "notes.txt"),
      "not a registry entry",
    );
    mkdirSync(path.join(directory, PARSER_ENTRY_DIRECTORY, "nested"), {
      recursive: true,
    });
    writeFileSync(
      path.join(directory, PARSER_ENTRY_DIRECTORY, "nested", "ignored.ts"),
      "not a registry entry",
    );
    mkdirSync(path.dirname(path.join(directory, PARSER_REGISTRY_OUTPUT)), {
      recursive: true,
    });

    generateParserRegistry(pathToFileURL(`${directory}/`));

    expect(
      readFileSync(path.join(directory, PARSER_REGISTRY_OUTPUT), "utf-8"),
    ).toBe(renderedRegistry(entries));
    generateParserRegistry(pathToFileURL(`${directory}/`), "check");
    writeFileSync(
      path.join(directory, PARSER_REGISTRY_OUTPUT),
      "// stale index\n",
    );
    expect(() =>
      generateParserRegistry(pathToFileURL(`${directory}/`), "check"),
    ).toThrow("Parser registry index is stale");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an empty entry directory fails with a descriptive invariant", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "parser-registry-empty-"));
  try {
    mkdirSync(path.join(directory, PARSER_ENTRY_DIRECTORY), {
      recursive: true,
    });
    expect(() =>
      generateParserRegistry(pathToFileURL(`${directory}/`)),
    ).toThrow(new TypeError("No parser registry entries"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("renderer ignores fake exports and rejects an incomplete entry", () => {
  const file = `${PARSER_ENTRY_DIRECTORY}incomplete.ts`;
  const source = [
    'export const ADAPTER_KEYS = { A: "a" } as const;',
    "export const PARSER_VERSIONS = { a: 1 };",
    "export const PARSER_VERSION_SCOPES = {};",
    "// export const SOURCE_FINGERPRINT_VERSIONS = {};",
    'const fake = "export const SOURCE_FINGERPRINT_VERSIONS = {};";',
  ].join("\n");

  expect(() => renderParserRegistry(new Map([[file, source]]))).toThrow(
    `Incomplete parser registry entry: ${file}`,
  );
});

test("source entries exclusively own registry declarations", () => {
  for (const file of ["ingestion-constants.ts", "parser-reparse-scopes.ts"]) {
    const source = readFileSync(
      path.join(root, registryDirectory, file),
      "utf-8",
    );
    for (const name of names) {
      expect(source).not.toMatch(
        new RegExp(`(?:const|let|var)\\s+${name}\\s*=`, "u"),
      );
    }
  }
  const seenKeys = new Set<string>();
  const seenNames = new Set<string>();
  for (const [file, source] of entrySources()) {
    const keys = [
      ...source.matchAll(
        /export const (?:ADAPTER_KEYS|IMPORT_SOURCE_KEYS) = \{\s*(\w+): "([^"]+)"\s*,?\s*\}/gu,
      ),
    ];
    expect(keys).toHaveLength(1);
    const key = keys.at(0)?.at(2);
    const name = keys.at(0)?.at(1);
    expect(key).toBe(path.basename(file, ".ts"));
    expect(seenKeys.has(String(key))).toBe(false);
    expect(seenNames.has(String(name))).toBe(false);
    seenKeys.add(String(key));
    seenNames.add(String(name));
  }
  expect(renderParserRegistry(entrySources())).toBe(
    readFileSync(path.join(root, PARSER_REGISTRY_OUTPUT), "utf-8"),
  );
});

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
  expect(result.stderr.toString(), args.join(" ")).not.toContain("CONFLICT");
  expect(
    result.exitCode,
    `${args.join(" ")}: ${result.stderr.toString()}`,
  ).toBe(0);
  return result.stdout.toString().trim();
};

for (const operation of ["add", "bump"] as const) {
  const mergeBehavior =
    operation === "add"
      ? "load both additions after regenerating the index"
      : "merge cleanly with an unchanged index";
  test(`independent parser ${operation} edits ${mergeBehavior}`, () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "parser-registry-merge-"),
    );
    try {
      mkdirSync(path.join(directory, PARSER_ENTRY_DIRECTORY), {
        recursive: true,
      });
      const sources = entrySources();
      for (const [file, source] of sources) {
        writeFileSync(path.join(directory, file), source);
      }
      const indexPath = path.join(directory, PARSER_REGISTRY_OUTPUT);
      mkdirSync(path.dirname(indexPath), { recursive: true });
      const baseIndex = renderedRegistry(sources);
      writeFileSync(indexPath, baseIndex);
      git(directory, ["init", "--initial-branch=base"]);
      git(directory, ["add", "."]);
      git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
      const original = record(loadRegistry(directory));
      const originalVersions = record(Reflect.get(original, "PARSER_VERSIONS"));
      const expected = structuredClone(original);
      for (const [branch, existing, added] of [
        ["left", "cz-ns", "test-left"],
        ["right", "cz-us", "test-right"],
      ] as const) {
        git(directory, ["switch", "-c", branch, "base"]);
        const file = `${PARSER_ENTRY_DIRECTORY}${existing}.ts`;
        const source = sources.get(file);
        if (source === undefined) {
          throw new TypeError("Missing merge fixture entry");
        }
        const symbol = existing.replaceAll("-", "_").toUpperCase();
        const newSymbol = added.replaceAll("-", "_").toUpperCase();
        const next =
          operation === "bump"
            ? source.replace(
                /((?:PARSER_VERSIONS = \{\s*\[ADAPTER_KEYS\.\w+\]:|version:)\s*)(\d+)/gu,
                (_, prefix: string, value: string) =>
                  `${prefix}${Number(value) + 1}`,
              )
            : source
                .replaceAll(existing, () => added)
                .replaceAll(symbol, () => newSymbol);
        const target =
          operation === "bump" ? file : `${PARSER_ENTRY_DIRECTORY}${added}.ts`;
        writeFileSync(path.join(directory, target), next);
        if (operation === "add") {
          const branchEntries = new Map([...sources, [target, next]]);
          writeFileSync(indexPath, renderedRegistry(branchEntries));
          git(directory, ["add", target, PARSER_REGISTRY_OUTPUT]);
        } else {
          expect(readFileSync(indexPath, "utf-8")).toBe(baseIndex);
          expect(renderedRegistry(new Map([...sources, [target, next]]))).toBe(
            baseIndex,
          );
          git(directory, ["add", target]);
        }
        git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", branch]);
        const edited = record(loadRegistry(directory));
        const editedVersions = record(Reflect.get(edited, "PARSER_VERSIONS"));
        const versionKey = operation === "bump" ? existing : added;
        const expectedVersion =
          operation === "bump"
            ? Reflect.get(originalVersions, existing) + 1
            : Reflect.get(originalVersions, existing);
        expect(Reflect.get(editedVersions, versionKey)).toBe(expectedVersion);
        for (const name of names) {
          if (name === "IMPORT_SOURCE_KEYS") {
            continue;
          }
          const adapterName = operation === "add" ? newSymbol : symbol;
          const key = name === "ADAPTER_KEYS" ? adapterName : versionKey;
          Reflect.set(
            record(Reflect.get(expected, name)),
            key,
            Reflect.get(record(Reflect.get(edited, name)), key),
          );
        }
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
      if (operation === "bump") {
        expect(merge.exitCode).toBe(0);
        expect(merge.stdout.toString()).not.toContain("CONFLICT");
        expect(
          git(directory, ["show", `${tree}:${PARSER_REGISTRY_OUTPUT}`]),
        ).toBe(baseIndex.trim());
      } else {
        expect([0, 1]).toContain(merge.exitCode);
        const conflicts = [
          ...merge.stdout.toString().matchAll(/CONFLICT .* in (.+)$/gmu),
        ].map((match) => match[1]);
        expect(conflicts.every((file) => file === PARSER_REGISTRY_OUTPUT)).toBe(
          true,
        );
      }
      git(directory, ["read-tree", "--reset", "-u", tree]);
      if (operation === "add") {
        generateParserRegistry(pathToFileURL(`${directory}/`));
        git(directory, ["add", PARSER_REGISTRY_OUTPUT]);
      }
      git(directory, ["diff", "--check"]);
      git(directory, ["write-tree"]);
      expect(record(loadRegistry(directory))).toEqual(expected);
      if (operation === "add") {
        const mergedKeys = record(
          Reflect.get(record(loadRegistry(directory)), "ADAPTER_KEYS"),
        );
        expect(Reflect.get(mergedKeys, "TEST_LEFT")).toBe("test-left");
        expect(Reflect.get(mergedKeys, "TEST_RIGHT")).toBe("test-right");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
