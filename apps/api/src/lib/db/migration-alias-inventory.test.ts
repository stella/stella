import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import nodePath from "node:path";

import migrationAliasInventory from "./migration-alias-inventory.json";
import {
  deriveMigrationAliasHistory,
  REWRITTEN_MIGRATION_HISTORIES,
  REWRITTEN_MIGRATION_INDEXES,
} from "./migration-history";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const bundledMigrations = readMigrationFiles({
  migrationsFolder: MIGRATIONS_DIR,
});

type AliasEdge = { fileName: string; priorHash: string; newHash: string };

const reachesHash = ({
  entry,
  inventory,
  bundledHash,
}: {
  entry: AliasEdge;
  inventory: readonly AliasEdge[];
  bundledHash: string;
}): boolean => {
  const seen = new Set<string>();
  const pending = [entry.newHash];
  while (pending.length > 0) {
    const hash = pending.pop();
    if (hash === bundledHash) {return true;}
    if (hash === undefined || seen.has(hash)) {continue;}
    seen.add(hash);
    pending.push(
      ...inventory
        .filter(
          ({ fileName, priorHash }) =>
            fileName === entry.fileName && priorHash === hash,
        )
        .map(({ newHash }) => newHash),
    );
  }
  return false;
};

describe("migration alias inventory", () => {
  test("every alias chain reaches the bundled file's current hash", () => {
    const hashByName = new Map(
      bundledMigrations.map(({ name, hash }) => [name, hash]),
    );
    expect(migrationAliasInventory.length).toBeGreaterThan(0);
    for (const entry of migrationAliasInventory) {
      const bundledHash = hashByName.get(entry.fileName);
      expect(bundledHash).toBeDefined();
      expect(
        reachesHash({
          entry,
          inventory: migrationAliasInventory,
          bundledHash: bundledHash ?? "",
        }),
      ).toBe(true);
    }
  });

  test("a two-rewrite chain reaches the bundle; a dangling alias does not", () => {
    const first = { fileName: "migration", priorHash: "A", newHash: "B" };
    const second = { fileName: "migration", priorHash: "B", newHash: "C" };
    const dangling = { fileName: "migration", priorHash: "X", newHash: "Y" };
    const inventory = [first, second, dangling];
    expect(reachesHash({ entry: first, inventory, bundledHash: "C" })).toBe(
      true,
    );
    expect(reachesHash({ entry: second, inventory, bundledHash: "C" })).toBe(
      true,
    );
    expect(reachesHash({ entry: dangling, inventory, bundledHash: "C" })).toBe(
      false,
    );
  });

  test("each inventory entry appears in the derived exports", () => {
    for (const { fileName, priorHash, repair } of migrationAliasInventory) {
      expect(REWRITTEN_MIGRATION_HISTORIES[fileName]?.priorHashes).toContain(
        priorHash,
      );
      if (typeof repair !== "string") {
        for (const index of repair.indexes) {
          expect(REWRITTEN_MIGRATION_INDEXES).toContainEqual(index);
        }
      }
    }
  });

  test("rejects conflicting definitions for an index repeated in one migration", () => {
    const index = {
      definitionBody: "ON public.records USING btree (record_id)",
      isUnique: false,
      name: "records_record_id_idx",
      tableName: "records",
    };
    const first = {
      fileName: "20260929120000_record_index",
      priorHash: "a",
      newHash: "b",
      repair: { indexes: [index] },
    };
    const next = { ...first, priorHash: "b", newHash: "c" };

    for (const changedIndex of [
      { ...index, definitionBody: "ON public.records USING btree (other_id)" },
      { ...index, isUnique: true },
      { ...index, tableName: "other_records" },
    ]) {
      expect(() =>
        deriveMigrationAliasHistory([
          first,
          { ...next, repair: { indexes: [changedIndex] } },
        ]),
      ).toThrow("Conflicting migration alias index records_record_id_idx");
    }
    expect(deriveMigrationAliasHistory([first, next]).indexes).toEqual([index]);
  });

  test("all bundled SQL files are UTF-8 without a byte-order mark", async () => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const { name } of bundledMigrations) {
      const bytes = await Bun.file(
        nodePath.join(MIGRATIONS_DIR, name, "migration.sql"),
      ).bytes();
      expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
      expect(decoder.decode(bytes).length).toBeGreaterThan(0);
    }
  });
});
