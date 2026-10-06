import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { addedEntries, parseReasonedLedger } from "./ledger-membership";
import {
  migrationLedger,
  parseOwnerLedger,
  sha256MigrationFiles,
} from "./sha256-migration-ledger";

// The same membership guard binds the real owner map and generated file ledger.
test("owner and migration membership admits removals and rejects additions or swaps", () => {
  for (const base of [
    ["owner-a", "owner-b"],
    ["file-a", "file-b"],
  ]) {
    const first = base.at(0);
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    expect(addedEntries([first], base)).toEqual([]);
    expect(addedEntries([first, "new-entry"], base)).toEqual(["new-entry"]);
  }
});

test("migration reasons and owner paths are derived from their source declarations", () => {
  const files = ["apps/api/src/a.ts", "apps/web/src/b.ts"];
  expect(
    parseReasonedLedger(JSON.stringify(migrationLedger(files)), "fixture"),
  ).toEqual(files);
  expect(
    parseOwnerLedger(
      'export const SHA256_OWNERS = { "packages/a/src/hash.ts": "runtime owner" } as const;',
      "fixture",
    ),
  ).toEqual(["packages/a/src/hash.ts"]);
  expect(() =>
    parseOwnerLedger(
      'export const SHA256_OWNERS = { "packages/a/src/hash.ts": "" } as const;',
      "fixture",
    ),
  ).toThrow("every owner needs a literal path and reason");
});

test("real census enumerates raw hashing while admitting exact registered owners", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sha256-census-"));
  const repository = path.resolve(import.meta.dir, "..");
  try {
    await mkdir(path.join(root, ".oxlint-plugins"));
    await symlink(
      path.join(repository, ".oxlint-plugins/no-raw-sha256.ts"),
      path.join(root, ".oxlint-plugins/no-raw-sha256.ts"),
    );
    await symlink(
      path.join(repository, "node_modules"),
      path.join(root, "node_modules"),
    );
    for (const filename of [
      "packages/sha256/src/node.ts",
      "apps/example/packages/sha256/src/node.ts",
      "scripts/example.ts",
    ]) {
      await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
      await writeFile(
        path.join(root, filename),
        'new Bun.CryptoHasher("sha256");',
      );
    }
    expect(sha256MigrationFiles(root)).toEqual([
      "apps/example/packages/sha256/src/node.ts",
      "scripts/example.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
