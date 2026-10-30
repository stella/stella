import { panic } from "better-result";
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

test("loaded parser registry preserves the base commit's keys and values", () => {
  generateParserRegistry();
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
  expect(loadRegistry(root)).toEqual(expected);
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

const git = (directory: string, args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
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
  expect(result.stderr.toString(), args.join(" ")).not.toContain("CONFLICT");
  expect(
    result.exitCode,
    `${args.join(" ")}: ${result.stderr.toString()}`,
  ).toBe(0);
  return result.stdout.toString().trim();
};

for (const operation of ["add", "bump"] as const) {
  test(`independent parser ${operation} edits merge and load both entries`, () => {
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
      writeFileSync(
        path.join(directory, ".gitignore"),
        `${PARSER_REGISTRY_OUTPUT}\n`,
      );
      git(directory, ["init", "--initial-branch=base"]);
      git(directory, ["add", "."]);
      git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
      const original = loadRegistry(root);
      if (typeof original !== "object" || original === null) {
        panic("Invalid original registry");
      }
      const expected = structuredClone(original);
      for (const [branch, existing, added] of [
        ["left", "cz-ns", "test-left"],
        ["right", "cz-us", "test-right"],
      ] as const) {
        git(directory, ["switch", "-c", branch, "base"]);
        const file = `${PARSER_ENTRY_DIRECTORY}${existing}.ts`;
        const source = sources.get(file);
        expect(source).toBeDefined();
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
        git(directory, ["add", target]);
        git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", branch]);
        // Import the edited singleton's runtime values using the production index renderer.
        const single = new Map([
          [target, next],
          ...[...sources].filter(([name]) =>
            name.endsWith("us-courtlistener.ts"),
          ),
        ]);
        writeFileSync(
          path.join(directory, PARSER_REGISTRY_OUTPUT),
          renderParserRegistry(single) ?? panic("Missing edited registry"),
        );
        const edited = loadRegistry(directory);
        if (typeof edited !== "object" || edited === null) {
          throw new TypeError("Invalid edited registry");
        }
        const editedVersions = Reflect.get(edited, "PARSER_VERSIONS");
        const originalVersions = Reflect.get(expected, "PARSER_VERSIONS");
        const expectedVersion =
          operation === "bump"
            ? Reflect.get(originalVersions, existing) + 1
            : Reflect.get(originalVersions, existing);
        expect(
          Reflect.get(editedVersions, operation === "bump" ? existing : added),
        ).toBe(expectedVersion);
        for (const name of names) {
          Object.assign(Reflect.get(expected, name), Reflect.get(edited, name));
        }
      }
      const tree = git(directory, [
        "merge-tree",
        "--write-tree",
        "left",
        "right",
      ]);
      git(directory, ["read-tree", "--reset", "-u", tree]);
      const merged = new Map(
        readdirSync(path.join(directory, PARSER_ENTRY_DIRECTORY)).map(
          (file) => [
            `${PARSER_ENTRY_DIRECTORY}${file}`,
            readFileSync(
              path.join(directory, PARSER_ENTRY_DIRECTORY, file),
              "utf-8",
            ),
          ],
        ),
      );
      writeFileSync(
        path.join(directory, PARSER_REGISTRY_OUTPUT),
        renderParserRegistry(merged) ?? panic("Missing merged registry"),
      );
      expect(loadRegistry(directory)).toEqual(expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
