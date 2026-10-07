import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import {
  findMigrationImmutabilityViolation,
  findMigrationIdentityViolation,
  formatAliasSummary,
  readMigrationBaseSnapshot,
  readMigrationChanges,
} from "./check-migration-order";

const migrationDirectory = (name: string) => `apps/api/drizzle/${name}`;
const FILE_NAME = "20260801120000_existing";
const FILE = `${migrationDirectory(FILE_NAME)}/migration.sql`;
const BASE_HASH = "a".repeat(64);
const HEAD_HASH = "b".repeat(64);
const NEXT_HASH = "c".repeat(64);
const alias = {
  fileName: FILE_NAME,
  priorHash: BASE_HASH,
  newHash: HEAD_HASH,
  reason: "Move repair to bounded online work.",
  repair: "none",
};

const immutabilityViolation = ({
  modifiedFiles = [FILE],
  baseInventory = [],
  headInventory = [],
  baseHashes = { [FILE]: BASE_HASH },
  headHashes = { [FILE]: HEAD_HASH },
}: {
  modifiedFiles?: readonly string[];
  baseInventory?: unknown;
  headInventory?: unknown;
  baseHashes?: Readonly<Record<string, string>>;
  headHashes?: Readonly<Record<string, string>>;
} = {}) =>
  findMigrationImmutabilityViolation({
    modifiedFiles,
    baseInventory,
    headInventory,
    baseHashes,
    headHashes,
  });

describe("migration identity", () => {
  test("accepts a migration stamped before one already on the base branch", () => {
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [migrationDirectory("20260801110000_late_arrival")],
        removedDirectories: [],
      }),
    ).toBeNull();
  });

  test("accepts two new migrations with the same timestamp", () => {
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [
          migrationDirectory("20260801140000_first"),
          migrationDirectory("20260801140000_second"),
        ],
        removedDirectories: [],
      }),
    ).toBeNull();
  });

  test("rejects a directory without the timestamp prefix", () => {
    const directory = migrationDirectory("report_export_result_field");
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [directory],
        removedDirectories: [],
      }),
    ).toEqual({ type: "invalid-name", directory });
  });

  test("rejects deleting a base migration", () => {
    const directory = migrationDirectory("20260801120000_existing");
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [],
        removedDirectories: [directory],
      }),
    ).toEqual({ type: "removed-base-migration", directory });
  });

  test("rejects renaming a base migration", () => {
    const directory = migrationDirectory("20260801120000_existing");
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [migrationDirectory("20260801130000_renamed")],
        removedDirectories: [directory],
      }),
    ).toEqual({ type: "removed-base-migration", directory });
  });

  test("accepts a pull request without migration changes", () => {
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [],
        removedDirectories: [],
      }),
    ).toBeNull();
  });

  test("a folder rename appears as a deletion and an addition in git", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "migration-identity-"));
    const runGit = (...arguments_: string[]) => {
      const result = Bun.spawnSync(["git", ...arguments_], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };
    try {
      runGit("init", "-b", "main");
      runGit("config", "user.name", "Test User");
      runGit("config", "user.email", "test@example.com");
      runGit("config", "commit.gpgsign", "false");
      const original = migrationDirectory("20260801120000_original");
      const renamed = migrationDirectory("20260801130000_renamed");
      mkdirSync(path.join(cwd, original), { recursive: true });
      writeFileSync(path.join(cwd, original, "migration.sql"), "SELECT 1;\n");
      runGit("add", ".");
      runGit("commit", "-m", "Initial migration");
      runGit("switch", "-c", "feature");
      renameSync(path.join(cwd, original), path.join(cwd, renamed));
      runGit("add", "-A");
      runGit("commit", "-m", "Rename migration");

      expect(
        runGit(
          "-c",
          "diff.renames=true",
          "diff",
          "--name-status",
          "main...HEAD",
        ),
      ).toContain("R100");
      expect(readMigrationChanges({ baseRef: "main", cwd })).toEqual({
        addedDirectories: [renamed],
        removedDirectories: [original],
        modifiedFiles: [],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("rejects an unsupported git status under the migration tree", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "migration-type-change-"));
    const runGit = (...arguments_: string[]) => {
      const result = Bun.spawnSync(["git", ...arguments_], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };
    try {
      runGit("init", "-b", "main");
      runGit("config", "user.name", "Test User");
      runGit("config", "user.email", "test@example.com");
      runGit("config", "commit.gpgsign", "false");
      mkdirSync(path.join(cwd, migrationDirectory(FILE_NAME)), {
        recursive: true,
      });
      writeFileSync(path.join(cwd, FILE), "SELECT 1;\n");
      runGit("add", ".");
      runGit("commit", "-m", "Initial migration");
      runGit("switch", "-c", "feature");
      unlinkSync(path.join(cwd, FILE));
      symlinkSync("missing.sql", path.join(cwd, FILE));
      runGit("add", ".");
      runGit("commit", "-m", "Change migration file type");
      expect(
        runGit("diff", "--name-status", "main...HEAD", "--", FILE),
      ).toContain(`T\t${FILE}`);
      expect(() => readMigrationChanges({ baseRef: "main", cwd })).toThrow(
        `Unsupported migration change status T for ${FILE}`,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("migration immutability", () => {
  test("rejects an edit to a base migration without a new matching alias", () => {
    expect(immutabilityViolation()).toEqual({
      type: "edited-base-migration",
      file: FILE,
      baseHash: BASE_HASH,
      headHash: HEAD_HASH,
    });
    expect(
      immutabilityViolation({ baseInventory: [alias], headInventory: [alias] }),
    ).toMatchObject({ type: "edited-base-migration" });
  });

  test("accepts a matching appended alias and summarizes it", () => {
    expect(immutabilityViolation({ headInventory: [alias] })).toBeNull();
    expect(formatAliasSummary([alias])).toContain(
      `| ${FILE_NAME} | ${BASE_HASH} | ${HEAD_HASH} | ${alias.reason} | none |`,
    );
  });

  test("rejects an alias whose predecessor does not match the base bytes", () => {
    const wrongAlias = { ...alias, priorHash: "c".repeat(64) };
    expect(
      immutabilityViolation({ headInventory: [wrongAlias] }),
    ).toMatchObject({ type: "edited-base-migration" });
  });

  test("rejects mutation or removal of a base inventory entry", () => {
    expect(
      immutabilityViolation({
        modifiedFiles: [],
        baseInventory: [alias],
        headInventory: [{ ...alias, reason: "changed" }],
      }),
    ).toEqual({ type: "inventory-mutated", index: 0 });
    expect(
      immutabilityViolation({
        modifiedFiles: [],
        baseInventory: [alias],
        headInventory: [],
      }),
    ).toEqual({ type: "inventory-mutated", index: 0 });
  });

  test("rejects malformed and orphan aliases", () => {
    for (const invalid of [
      { ...alias, reason: " " },
      { ...alias, repair: undefined },
      { ...alias, newHash: "c".repeat(64) },
    ]) {
      expect(
        immutabilityViolation({ modifiedFiles: [], headInventory: [invalid] }),
      ).toMatchObject({ type: "alias-invalid" });
    }
  });

  test("accepts an alias revert and a later edit after the revert", () => {
    const revert = {
      ...alias,
      priorHash: HEAD_HASH,
      newHash: BASE_HASH,
    };
    const laterEdit = { ...alias, newHash: NEXT_HASH };
    expect(
      immutabilityViolation({
        modifiedFiles: [],
        headInventory: [alias, revert],
        headHashes: { [FILE]: BASE_HASH },
      }),
    ).toBeNull();
    expect(
      immutabilityViolation({
        modifiedFiles: [],
        headInventory: [alias, revert, laterEdit],
        headHashes: { [FILE]: NEXT_HASH },
      }),
    ).toBeNull();
  });

  test("accepts a multi-hop alias chain and rejects an unreachable cycle", () => {
    const next = { ...alias, priorHash: HEAD_HASH, newHash: NEXT_HASH };
    expect(
      immutabilityViolation({
        modifiedFiles: [],
        headInventory: [alias, next],
        headHashes: { [FILE]: NEXT_HASH },
      }),
    ).toBeNull();
    expect(
      immutabilityViolation({
        modifiedFiles: [],
        headInventory: [
          alias,
          { ...alias, priorHash: HEAD_HASH, newHash: BASE_HASH },
        ],
        headHashes: { [FILE]: NEXT_HASH },
      }),
    ).toMatchObject({ type: "alias-invalid" });
  });

  test("rejects conflicting index definitions for the same file and name", () => {
    const repairIndex = {
      definitionBody: "ON public.docs USING btree (id)",
      isUnique: false,
      name: "docs_id_idx",
      tableName: "docs",
    };
    const first = { ...alias, repair: { indexes: [repairIndex] } };
    const second = {
      ...alias,
      priorHash: HEAD_HASH,
      newHash: NEXT_HASH,
      repair: {
        indexes: [
          {
            ...repairIndex,
            definitionBody: "ON public.docs USING btree (name)",
          },
        ],
      },
    };
    expect(
      immutabilityViolation({
        modifiedFiles: [],
        headInventory: [first, second],
        headHashes: { [FILE]: NEXT_HASH },
      }),
    ).toMatchObject({
      type: "alias-invalid",
      detail: `conflicting index repair ${FILE_NAME}:docs_id_idx`,
    });
    expect(
      immutabilityViolation({
        modifiedFiles: [],
        headInventory: [first, { ...second, repair: first.repair }],
        headHashes: { [FILE]: NEXT_HASH },
      }),
    ).toBeNull();
  });

  test("rejects edits to a non-SQL file in a base migration folder", () => {
    const snapshot = `${migrationDirectory(FILE_NAME)}/snapshot.json`;
    expect(immutabilityViolation({ modifiedFiles: [snapshot] })).toEqual({
      type: "edited-non-sql-in-base-folder",
      file: snapshot,
    });
  });

  test("git distinguishes edits to base migrations from edits to new migrations", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "migration-edit-"));
    const runGit = (...arguments_: string[]) => {
      const result = Bun.spawnSync(["git", ...arguments_], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
    };
    try {
      runGit("init", "-b", "main");
      runGit("config", "user.name", "Test User");
      runGit("config", "user.email", "test@example.com");
      runGit("config", "commit.gpgsign", "false");
      mkdirSync(path.join(cwd, migrationDirectory(FILE_NAME)), {
        recursive: true,
      });
      writeFileSync(path.join(cwd, FILE), "SELECT 1;\n");
      runGit("add", ".");
      runGit("commit", "-m", "Initial migration");
      runGit("switch", "-c", "feature");
      writeFileSync(path.join(cwd, FILE), "SELECT 2;\n");
      runGit("add", ".");
      runGit("commit", "-m", "Edit migration");

      const addedDirectory = migrationDirectory("20260801130000_new");
      const addedFile = `${addedDirectory}/migration.sql`;
      mkdirSync(path.join(cwd, addedDirectory), { recursive: true });
      writeFileSync(path.join(cwd, addedFile), "SELECT 3;\n");
      runGit("add", ".");
      runGit("commit", "-m", "Add migration");
      writeFileSync(path.join(cwd, addedFile), "SELECT 4;\n");
      runGit("add", ".");
      runGit("commit", "-m", "Edit new migration");

      expect(readMigrationChanges({ baseRef: "main", cwd })).toEqual({
        addedDirectories: [addedDirectory],
        removedDirectories: [],
        modifiedFiles: [FILE],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("compares a branch behind main against its merge base", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "migration-merge-base-"));
    const inventoryPath = "apps/api/src/lib/db/migration-alias-inventory.json";
    const originalSql = "SELECT 1;\n";
    const editedSql = "SELECT 2;\n";
    const runGit = (...arguments_: string[]) => {
      const result = Bun.spawnSync(["git", ...arguments_], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    try {
      runGit("init", "-b", "main");
      runGit("config", "user.name", "Test User");
      runGit("config", "user.email", "test@example.com");
      runGit("config", "commit.gpgsign", "false");
      mkdirSync(path.join(cwd, migrationDirectory(FILE_NAME)), {
        recursive: true,
      });
      mkdirSync(path.join(cwd, path.dirname(inventoryPath)), {
        recursive: true,
      });
      writeFileSync(path.join(cwd, FILE), originalSql);
      writeFileSync(path.join(cwd, inventoryPath), "[]\n");
      runGit("add", ".");
      runGit("commit", "-m", "Initial migration");
      const branchPoint = runGit("rev-parse", "HEAD");

      runGit("switch", "-c", "feature");
      writeFileSync(path.join(cwd, "note.txt"), "Unrelated branch change\n");
      runGit("add", ".");
      runGit("commit", "-m", "Change note");

      runGit("switch", "main");
      const mainAlias = {
        ...alias,
        fileName: "20260801130000_unrelated",
      };
      writeFileSync(
        path.join(cwd, inventoryPath),
        `${JSON.stringify([mainAlias])}\n`,
      );
      runGit("add", ".");
      runGit("commit", "-m", "Append unrelated alias");
      expect(runGit("show", `main:${inventoryPath}`)).toContain(
        mainAlias.fileName,
      );
      runGit("switch", "feature");

      const unchanged = readMigrationBaseSnapshot({ baseRef: "main", cwd });
      expect(unchanged.mergeBase).toBe(branchPoint);
      expect(unchanged.changes.modifiedFiles).toEqual([]);
      expect(unchanged.baseInventory).toEqual([]);
      expect(
        findMigrationImmutabilityViolation({
          modifiedFiles: unchanged.changes.modifiedFiles,
          baseInventory: unchanged.baseInventory,
          headInventory: [],
          baseHashes: unchanged.baseHashes,
          headHashes: {},
        }),
      ).toBeNull();

      writeFileSync(path.join(cwd, FILE), editedSql);
      runGit("add", ".");
      runGit("commit", "-m", "Edit migration");
      const edited = readMigrationBaseSnapshot({ baseRef: "main", cwd });
      expect(edited.mergeBase).toBe(branchPoint);
      expect(edited.changes.modifiedFiles).toEqual([FILE]);
      expect(edited.baseInventory).toEqual([]);
      expect(edited.baseHashes).toEqual({ [FILE]: hashSha256Hex(originalSql) });
      const headHashes = {
        [FILE]: hashSha256Hex(readFileSync(path.join(cwd, FILE), "utf-8")),
      };
      expect(
        findMigrationImmutabilityViolation({
          modifiedFiles: edited.changes.modifiedFiles,
          baseInventory: edited.baseInventory,
          headInventory: [],
          baseHashes: edited.baseHashes,
          headHashes,
        }),
      ).toEqual({
        type: "edited-base-migration",
        file: FILE,
        baseHash: hashSha256Hex(originalSql),
        headHash: hashSha256Hex(editedSql),
      });

      const branchAlias = {
        ...alias,
        priorHash: hashSha256Hex(originalSql),
        newHash: hashSha256Hex(editedSql),
      };
      writeFileSync(
        path.join(cwd, inventoryPath),
        `${JSON.stringify([branchAlias])}\n`,
      );
      runGit("add", ".");
      runGit("commit", "-m", "Record migration alias");
      const aliased = readMigrationBaseSnapshot({ baseRef: "main", cwd });
      expect(
        findMigrationImmutabilityViolation({
          modifiedFiles: aliased.changes.modifiedFiles,
          baseInventory: aliased.baseInventory,
          headInventory: [branchAlias],
          baseHashes: aliased.baseHashes,
          headHashes,
        }),
      ).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("the migration CLI rejects bad new dependencies and accepts an aliased base edit", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "migration-cli-"));
  const scriptPath = path.join(cwd, "scripts/check-migration-order.ts");
  const ledgerPath = path.join(cwd, "apps/api/src/lib/db/migration-ledger.ts");
  const inventoryPath = path.join(
    cwd,
    "apps/api/src/lib/db/migration-alias-inventory.json",
  );
  const runGit = (...arguments_: string[]) => {
    const result = Bun.spawnSync(["git", ...arguments_], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
  };
  const runGate = () =>
    Bun.spawnSync([process.execPath, scriptPath, "main"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  try {
    mkdirSync(path.dirname(scriptPath), { recursive: true });
    mkdirSync(path.dirname(ledgerPath), { recursive: true });
    mkdirSync(path.join(cwd, migrationDirectory(FILE_NAME)), {
      recursive: true,
    });
    copyFileSync(
      path.join(import.meta.dir, "check-migration-order.ts"),
      scriptPath,
    );
    copyFileSync(
      path.resolve(
        import.meta.dir,
        "../apps/api/src/lib/db/migration-ledger.ts",
      ),
      ledgerPath,
    );
    writeFileSync(inventoryPath, "[]\n");
    const originalSql = "SELECT 1;\n";
    writeFileSync(path.join(cwd, FILE), originalSql);
    runGit("init", "-b", "main");
    runGit("config", "user.name", "Test User");
    runGit("config", "user.email", "test@example.com");
    runGit("config", "commit.gpgsign", "false");
    runGit("add", "apps", "scripts");
    runGit("commit", "-m", "Initial migration");
    symlinkSync(
      path.resolve(import.meta.dir, "../node_modules"),
      path.join(cwd, "node_modules"),
      "dir",
    );

    const added = migrationDirectory("20260801130000_added");
    runGit("switch", "-c", "malformed");
    mkdirSync(path.join(cwd, added), { recursive: true });
    writeFileSync(
      path.join(cwd, added, "migration.sql"),
      "  -- requires: 2026080112000_missing\nSELECT 2;\n",
    );
    runGit("add", "apps/api/drizzle");
    runGit("commit", "-m", "Add malformed dependency");
    const malformed = runGate();
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr.toString()).toContain(
      "Malformed migration dependency",
    );

    runGit("switch", "main");
    runGit("switch", "-c", "missing");
    mkdirSync(path.join(cwd, added), { recursive: true });
    writeFileSync(
      path.join(cwd, added, "migration.sql"),
      "-- requires: 20260801110000_missing\nSELECT 2;\n",
    );
    runGit("add", "apps/api/drizzle");
    runGit("commit", "-m", "Add missing dependency");
    const missing = runGate();
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain(
      "Migration dependency violation",
    );

    runGit("switch", "main");
    runGit("switch", "-c", "aliased");
    const editedSql = "SELECT 3;\n";
    writeFileSync(path.join(cwd, FILE), editedSql);
    writeFileSync(
      inventoryPath,
      `${JSON.stringify([{ ...alias, priorHash: hashSha256Hex(originalSql), newHash: hashSha256Hex(editedSql) }])}\n`,
    );
    runGit("add", "apps");
    runGit("commit", "-m", "Alias edited migration");
    const aliased = runGate();
    expect(aliased.stderr.toString()).toBe("");
    expect(aliased.exitCode).toBe(0);

    const malformedAliasedSql =
      "  -- requires: 2026080111000_missing\nSELECT 4;\n";
    writeFileSync(path.join(cwd, FILE), malformedAliasedSql);
    writeFileSync(
      inventoryPath,
      `${JSON.stringify([{ ...alias, priorHash: hashSha256Hex(originalSql), newHash: hashSha256Hex(malformedAliasedSql) }])}\n`,
    );
    runGit("add", "apps");
    runGit("commit", "-m", "Add malformed header to aliased migration");
    const malformedAliased = runGate();
    expect(malformedAliased.exitCode).not.toBe(0);
    expect(malformedAliased.stderr.toString()).toContain(
      "Malformed migration dependency",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
