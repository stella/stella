import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { addedEntries } from "./ledger-membership";
import { parseOwnerLedger, rawSha256Files } from "./sha256-migration-ledger";

// The membership guard binds the real owner map.
test("owner membership admits removals and rejects additions or swaps", () => {
  const base = ["owner-a", "owner-b"];
  expect(addedEntries(["owner-a"], base)).toEqual([]);
  expect(addedEntries(["owner-a", "new-entry"], base)).toEqual(["new-entry"]);
});

test("owner paths are derived from their source declaration", () => {
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
    // A file the repository does not track (a checked-out submodule's
    // content) never enters the census.
    await mkdir(path.join(root, "packages/content/scripts"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "packages/content/scripts/external.ts"),
      'new Bun.CryptoHasher("sha256");',
    );
    for (const command of [
      ["git", "init", "-q"],
      [
        "git",
        "add",
        "packages/sha256/src/node.ts",
        "apps/example/packages/sha256/src/node.ts",
        "scripts/example.ts",
      ],
    ]) {
      expect(Bun.spawnSync(command, { cwd: root }).exitCode).toBe(0);
    }
    expect(rawSha256Files(root)).toEqual([
      "apps/example/packages/sha256/src/node.ts",
      "scripts/example.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
