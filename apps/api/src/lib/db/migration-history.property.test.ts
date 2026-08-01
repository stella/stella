import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import nodePath from "node:path";

import { propertyConfig } from "@stll/property-testing";

import {
  assertMigrationHistory,
  findUnappliedMigrations,
  REWRITTEN_MIGRATION_HISTORIES,
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
  { minLength: 1, selector: ({ hash }) => hash },
);

const migrationHistory = localMigrations.chain((local) =>
  fc
    .tuple(
      fc.array(fc.boolean(), {
        minLength: local.length,
        maxLength: local.length,
      }),
      fc.array(fc.uuid(), { maxLength: 10 }),
    )
    .map(([isApplied, unrelatedHashes]) => ({
      appliedHashes: new Set([
        ...local.filter((_, index) => isApplied[index]).map(({ hash }) => hash),
        ...unrelatedHashes.map((hash) => `unrelated-${hash}`),
      ]),
      expectedUnapplied: local.filter((_, index) => !isApplied[index]),
      local,
    })),
);

describe("migration history invariant", () => {
  test("reports exactly the bundled hashes absent from any applied history", () => {
    fc.assert(
      fc.property(
        migrationHistory,
        ({ appliedHashes, expectedUnapplied, local }) => {
          expect(
            findUnappliedMigrations({
              appliedHashes,
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
        const actualHash = new Bun.CryptoHasher("sha256")
          .update(
            await Bun.file(
              nodePath.join(MIGRATIONS_DIR, name, "migration.sql"),
            ).bytes(),
          )
          .digest("hex");
        expect(actualHash).toBe(currentHash);
        expect(
          findUnappliedMigrations({
            appliedHashes: new Set([priorHash]),
            localMigrations: [{ hash: currentHash, name }],
          }),
        ).toEqual([]);
        expect(
          findUnappliedMigrations({
            appliedHashes: new Set([priorHash]),
            localMigrations: [{ hash: `modified-${currentHash}`, name }],
          }),
        ).toEqual([{ hash: `modified-${currentHash}`, name }]);
      }),
    );
  });

  test("reports the intended error when the migrations directory is absent", async () => {
    const rejection: unknown = await assertMigrationHistory({
      context: "migrate",
      migrationsDir: nodePath.join(import.meta.dir, "missing-migrations"),
      queryAppliedHashes: async () => new Set(),
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
