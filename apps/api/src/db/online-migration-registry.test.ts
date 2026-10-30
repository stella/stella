import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { OnlineMigrationEntry } from "./online-migration-entry";
import {
  ONLINE_MIGRATION_ENTRIES,
  orderOnlineMigrationEntries,
} from "./online-migration-registry";

const root = path.resolve(import.meta.dirname, "../../../..");
const fixtureEntry = (id: string, revision: number) =>
  ({
    id,
    revision,
    type: "indexes",
    values: [
      {
        name: id,
        tableName: "fixture",
        introducedBy: "fixture",
        isUnique: false,
        definitionBody: "ON public.fixture USING btree (id)",
        createSql: `CREATE INDEX CONCURRENTLY ${id} ON public.fixture (id)`,
      },
    ],
  }) satisfies OnlineMigrationEntry;

type RunOptions = { cwd: string; command: string; args: string[] };
const run = ({ cwd, command, args }: RunOptions) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result.stdout.trim();
};

// Each exported list must be derived directly; an inline entry or appended
// spread would reintroduce a shared edit point.
const projections = (source: string) =>
  [
    ...source.matchAll(
      /export const (ONLINE_MIGRATION_INDEXES|ONLINE_MIGRATION_INDEX_CUTOVERS|ONLINE_INDEX_REPLACEMENTS|ONLINE_MIGRATION_REPAIRS|ONLINE_CONSTRAINT_VALIDATIONS)\s*(?::\s*readonly\s+\w+\[\])?\s*=\s*([^;]+);/gu,
    ),
  ].map((match) => match.at(2)?.replaceAll(/[()\s,]/gu, ""));
const isProjection = (source: string) => {
  const lists = projections(source);
  return (
    lists.length === 5 &&
    lists.every((expression) =>
      /^ONLINE_MIGRATION_ENTRIES\.flatMapentry=>entry\.type==="(indexes|cutovers|replacements|repairs|constraints)"\?entry\.values:\[\]$/u.test(
        expression ?? "",
      ),
    )
  );
};

describe("online migration entry contract", () => {
  test("revisions strictly order entries with unique ids", () => {
    expect(ONLINE_MIGRATION_ENTRIES.length).toBeGreaterThan(0);
    const files = readdirSync(
      new URL("online-migration-entries/", import.meta.url),
    )
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.slice(0, -3))
      .toSorted();
    expect(ONLINE_MIGRATION_ENTRIES.map(({ id }) => id).toSorted()).toEqual(
      files,
    );
    expect(new Set(ONLINE_MIGRATION_ENTRIES.map(({ id }) => id)).size).toBe(
      ONLINE_MIGRATION_ENTRIES.length,
    );
    let previous = 0;
    for (const entry of ONLINE_MIGRATION_ENTRIES) {
      expect(entry.revision).toBeGreaterThan(previous);
      previous = entry.revision;
    }
    expect(
      orderOnlineMigrationEntries(ONLINE_MIGRATION_ENTRIES.toReversed()),
    ).toEqual(ONLINE_MIGRATION_ENTRIES);
  });

  test("duplicate identities and invalid revisions fail explicitly", () => {
    expect(() =>
      orderOnlineMigrationEntries([fixtureEntry("a", 1), fixtureEntry("a", 2)]),
    ).toThrow("ids and revisions must be unique");
    expect(() =>
      orderOnlineMigrationEntries([fixtureEntry("a", 1), fixtureEntry("b", 1)]),
    ).toThrow("ids and revisions must be unique");
    for (const revision of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        orderOnlineMigrationEntries([fixtureEntry("a", revision)]),
      ).toThrow("positive integer revision");
    }
  });

  test("the committed entry index is fresh", () => {
    run({
      cwd: root,
      command: process.execPath,
      args: ["scripts/generate-online-migration-entries.ts", "--check"],
    });
  });

  test("all lists derive from entries and refuse inline additions", () => {
    const source = readFileSync(
      new URL("online-migrations.ts", import.meta.url),
      "utf-8",
    );
    expect(isProjection(source)).toBe(true);
    const inline = source.replace(
      "entry.values",
      '[...entry.values, { name: "new-step" }]',
    );
    expect(inline).not.toBe(source);
    expect(isProjection(inline)).toBe(false);
  });

  test.each([
    { placement: "separated", left: "a", right: "z", mergeStatus: 0 },
    { placement: "adjacent", left: "y", right: "z", mergeStatus: 1 },
  ])(
    "$placement additions retain both entries after merging or regeneration",
    ({ left, right, mergeStatus }) => {
      const directory = mkdtempSync(path.join(tmpdir(), "online-entry-merge-"));
      try {
        const db = path.join(directory, "apps/api/src/db");
        mkdirSync(path.join(db, "online-migration-entries"), {
          recursive: true,
        });
        mkdirSync(path.join(directory, "scripts"));
        for (const name of [
          "online-migration-registry.ts",
          "online-migration-entry.ts",
        ]) {
          copyFileSync(
            path.join(root, "apps/api/src/db", name),
            path.join(db, name),
          );
        }
        copyFileSync(
          path.join(root, "scripts/generate-online-migration-entries.ts"),
          path.join(directory, "scripts/generate-online-migration-entries.ts"),
        );
        symlinkSync(
          path.join(root, "node_modules"),
          path.join(directory, "node_modules"),
        );
        writeFileSync(path.join(directory, ".gitignore"), "node_modules\n");
        const git = (args: string[]) =>
          run({
            cwd: directory,
            command: "git",
            args: ["-c", "core.attributesFile=/dev/null", ...args],
          });
        const generate = () =>
          run({
            cwd: directory,
            command: process.execPath,
            args: ["scripts/generate-online-migration-entries.ts"],
          });
        const check = () =>
          run({
            cwd: directory,
            command: process.execPath,
            args: ["scripts/generate-online-migration-entries.ts", "--check"],
          });
        const add = (id: string, revision: number) => {
          writeFileSync(
            path.join(db, "online-migration-entries", `${id}.ts`),
            `export default ${JSON.stringify(fixtureEntry(id, revision))};\n`,
          );
          generate();
          check();
        };
        const commit = () => {
          git(["add", "."]);
          git([
            "-c",
            "user.name=Registry Test",
            "-c",
            "user.email=registry@example.test",
            "commit",
            "-m",
            "entry",
          ]);
        };
        git(["init", "-b", "base"]);
        const baseIds = ["d", "h", "l", "p", "t", "x"];
        for (const [index, id] of baseIds.entries()) {
          add(id, (index + 1) * 10);
        }
        commit();
        git(["checkout", "-b", "left"]);
        add(left, 80);
        commit();
        git(["checkout", "-b", "right", "base"]);
        add(right, 70);
        commit();
        const merge = spawnSync(
          "git",
          [
            "-c",
            "core.attributesFile=/dev/null",
            "merge-tree",
            "--write-tree",
            "left",
            "right",
          ],
          {
            cwd: directory,
            encoding: "utf-8",
            maxBuffer: 32 * 1024 * 1024,
            env: {
              ...process.env,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
            },
          },
        );
        expect(merge.status, merge.stderr + merge.stdout).toBe(mergeStatus);
        const tree = merge.stdout.split("\n").at(0);
        expect(tree).toMatch(/^[a-f0-9]{40}$/u);
        if (!tree) {
          throw new TypeError("merge-tree returned no tree");
        }
        git(["read-tree", "--reset", "-u", tree]);
        if (mergeStatus === 1) {
          expect(merge.stdout).toContain("CONFLICT (content)");
          expect(merge.stdout).toContain("online-migration-entries.gen.ts");
          const stale = spawnSync(
            process.execPath,
            ["scripts/generate-online-migration-entries.ts", "--check"],
            { cwd: directory, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
          );
          expect(stale.status).toBe(1);
          expect(stale.stderr).toContain(
            "Online migration entry index is stale",
          );
          generate();
        }
        check();
        const loaded = run({
          cwd: directory,
          command: process.execPath,
          args: [
            "-e",
            'import { ONLINE_MIGRATION_ENTRIES } from "./apps/api/src/db/online-migration-registry.ts"; console.log(JSON.stringify(ONLINE_MIGRATION_ENTRIES.map(({id}) => id)))',
          ],
        });
        expect(JSON.parse(loaded)).toEqual([...baseIds, right, left]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
