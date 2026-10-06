import { describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { propertyConfig } from "@stll/property-testing";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import {
  assertMigrationHistory,
  findUnappliedMigrations,
  REWRITTEN_MIGRATION_HISTORIES,
  summarizeLedgerAhead,
} from "./migration-history";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const hexadecimalCharacter = fc.constantFrom(..."0123456789abcdef".split(""));
const migrationHash = fc.string({
  unit: hexadecimalCharacter,
  minLength: 64,
  maxLength: 64,
});
const localMigrations = fc.uniqueArray(
  fc.record({
    hash: migrationHash,
    name: fc.uuid(),
  }),
  { minLength: 1, selector: ({ name }) => name },
);

const migrationHistory = localMigrations.chain((local) =>
  fc
    .array(fc.constantFrom("named", "unnamed", "missing"), {
      minLength: local.length,
      maxLength: local.length,
    })
    .map((status) => ({
      appliedRows: [
        ...local.flatMap(({ name, hash }, index) => {
          if (status[index] === "missing") {
            return [];
          }
          return [{ name: status[index] === "named" ? name : null, hash }];
        }),
        // These rows share bundled hashes but belong to newer migrations.
        ...local.map(({ hash }, index) => ({ name: `newer-${index}`, hash })),
      ],
      expectedUnapplied: local.filter(
        (_, index) => status[index] === "missing",
      ),
      local,
    })),
);

describe("migration history invariant", () => {
  test("requires a named receipt or an unnamed legacy hash for each bundled migration", () => {
    fc.assert(
      fc.property(
        migrationHistory,
        ({ appliedRows, expectedUnapplied, local }) => {
          expect(
            findUnappliedMigrations({
              appliedRows,
              localMigrations: local,
            }),
          ).toEqual(expectedUnapplied);
        },
      ),
      propertyConfig(),
    );
  });

  test("accepts every supported predecessor only for its exact current file", async () => {
    const supportedHistories = Object.entries(
      REWRITTEN_MIGRATION_HISTORIES,
    ).flatMap(([name, { currentHash, priorHashes }]) =>
      priorHashes.map((priorHash) => [name, currentHash, priorHash] as const),
    );
    expect(supportedHistories.length).toBeGreaterThan(0);

    await Promise.all(
      supportedHistories.map(async ([name, currentHash, priorHash]) => {
        const actualHash = hashSha256Hex(
          await Bun.file(
            nodePath.join(MIGRATIONS_DIR, name, "migration.sql"),
          ).bytes(),
        );
        expect(actualHash).toBe(currentHash);
        expect(
          findUnappliedMigrations({
            appliedRows: [{ name, hash: priorHash }],
            localMigrations: [{ hash: currentHash, name }],
          }),
        ).toEqual([]);
        expect(
          findUnappliedMigrations({
            appliedRows: [{ name, hash: priorHash }],
            localMigrations: [{ hash: `modified-${currentHash}`, name }],
          }),
        ).toEqual([{ hash: `modified-${currentHash}`, name }]);
        expect(
          findUnappliedMigrations({
            appliedRows: [{ name: null, hash: priorHash }],
            localMigrations: [{ hash: currentHash, name }],
          }),
        ).toEqual([]);
      }),
    );
  });

  test("does not let a NULL-name hash hide a mismatched named receipt", () => {
    const migration = { name: "20260929000000_example", hash: "current-hash" };
    expect(
      findUnappliedMigrations({
        appliedRows: [
          { name: migration.name, hash: "wrong-hash" },
          { name: null, hash: migration.hash },
        ],
        localMigrations: [migration],
      }),
    ).toEqual([migration]);
  });

  // Two byte-identical migrations share a hash; one unnamed receipt is proof
  // that only one of them ran.
  test("one NULL-name receipt satisfies only one of two identical migrations", () => {
    const first = { name: "20260707100000_drop_shortcuts", hash: "same-hash" };
    const second = { name: "20260707130000_drop_shortcuts", hash: "same-hash" };
    expect(
      findUnappliedMigrations({
        appliedRows: [{ name: null, hash: "same-hash" }],
        localMigrations: [first, second],
      }),
    ).toEqual([second]);
    expect(
      findUnappliedMigrations({
        appliedRows: [
          { name: null, hash: "same-hash" },
          { name: null, hash: "same-hash" },
        ],
        localMigrations: [first, second],
      }),
    ).toEqual([]);
  });

  test("allows startup after a newer alias rewrite and a newer migration, with one raw event", async () => {
    const migrationsDir = mkdtempSync(
      nodePath.join(tmpdir(), "stella-startup-migrations-"),
    );
    try {
      const name = "20260929000000_bundled";
      const sqlText = "SELECT 1;";
      const hash = hashSha256Hex(sqlText);
      const rewrittenHash = hashSha256Hex(`-- rewritten\n${sqlText}`);
      const newerName = "20260930000000_newer";
      const folder = nodePath.join(migrationsDir, name);
      mkdirSync(folder);
      writeFileSync(nodePath.join(folder, "migration.sql"), sqlText);
      const appliedRows = [
        { name, hash: rewrittenHash },
        { name: newerName, hash: "newer-hash" },
      ];
      expect(hash).not.toBe(rewrittenHash);
      expect(
        summarizeLedgerAhead({
          appliedRows,
          localMigrations: [{ name, hash }],
        }),
      ).toEqual({
        unknownCount: 1,
        newestUnknownName: newerName,
        unknownNames: [newerName],
        mismatchCount: 1,
        mismatchedNames: [name],
      });
      const stdout = spyOn(process.stdout, "write").mockImplementation(
        () => true,
      );
      try {
        await assertMigrationHistory({
          context: "startup",
          migrationsDir,
          queryAppliedRows: async () => appliedRows,
          remedy: "No remedy.",
        });
        expect(stdout.mock.calls).toHaveLength(1);
        expect(JSON.parse(String(stdout.mock.calls.at(0)?.at(0)))).toEqual({
          event: "migrate.ledger_ahead",
          level: "warn",
          unknownCount: 1,
          newestUnknownName: newerName,
          unknownNames: [newerName],
          mismatchCount: 1,
          mismatchedNames: [name],
        });
      } finally {
        stdout.mockRestore();
      }
    } finally {
      rmSync(migrationsDir, { recursive: true, force: true });
    }
  });

  test("reports the intended error when the migrations directory is absent", async () => {
    const rejection: unknown = await assertMigrationHistory({
      context: "migrate",
      migrationsDir: nodePath.join(import.meta.dir, "missing-migrations"),
      queryAppliedRows: async () => [],
      remedy: "No remedy.",
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({
      message: expect.stringContaining("No migration files"),
    });
  });
});
