import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import nodePath from "node:path";

import migrationAliasInventory from "./migration-alias-inventory.json";
import legacySnapshot from "./migration-alias-legacy.test.json";
import {
  deriveMigrationAliasHistory,
  REWRITTEN_MIGRATION_HISTORIES,
  REWRITTEN_MIGRATION_INDEXES,
} from "./migration-history";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const bundledMigrations = readMigrationFiles({
  migrationsFolder: MIGRATIONS_DIR,
});

describe("migration alias inventory", () => {
  test("every alias ends at the bundled file's current hash", () => {
    const hashByName = new Map(
      bundledMigrations.map(({ name, hash }) => [name, hash]),
    );
    expect(migrationAliasInventory.length).toBeGreaterThan(0);
    for (const { fileName, newHash } of migrationAliasInventory) {
      expect(hashByName.get(fileName)).toBe(newHash);
    }
  });

  test("derived exports preserve the previous literal values", () => {
    expect(REWRITTEN_MIGRATION_HISTORIES).toEqual(legacySnapshot.histories);
    expect(REWRITTEN_MIGRATION_INDEXES).toEqual(legacySnapshot.indexes);
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
