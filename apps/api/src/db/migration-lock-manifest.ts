import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

export const MIGRATION_LOCK_MANIFEST_FILE = "table-lock-manifest.json";
export const MIGRATION_RELATION_LOCK_MODES = [
  "ACCESS SHARE",
  "ROW SHARE",
  "ROW EXCLUSIVE",
  "SHARE UPDATE EXCLUSIVE",
  "SHARE",
  "SHARE ROW EXCLUSIVE",
  "EXCLUSIVE",
  "ACCESS EXCLUSIVE",
] as const;

const relationLockSchema = v.strictObject({
  // A wildcard is the census's explicit unresolved dependency, never an empty set.
  relation: v.pipe(v.string(), v.minLength(1)),
  mode: v.picklist(MIGRATION_RELATION_LOCK_MODES),
});
const manifestSchema = v.strictObject({
  version: v.literal(1),
  migrations: v.record(
    v.pipe(v.string(), v.regex(/^\d{14}_[\w-]+$/u)),
    v.strictObject({
      hash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
      locks: v.array(relationLockSchema),
    }),
  ),
});

export type MigrationRelationLock = v.InferOutput<typeof relationLockSchema>;
export type MigrationLockManifest = v.InferOutput<typeof manifestSchema>;

type BundledMigration = { name: string; hash: string };

type ParseMigrationLockManifestOptions = {
  value: unknown;
  migrations: readonly BundledMigration[];
};

export const parseMigrationLockManifest = ({
  value,
  migrations,
}: ParseMigrationLockManifestOptions): MigrationLockManifest => {
  const parsed = v.safeParse(manifestSchema, value);
  if (!parsed.success) {
    return panic(
      "Migration table lock manifest is malformed or has an unknown version",
    );
  }
  const manifest = parsed.output;
  if (Object.keys(manifest.migrations).length !== migrations.length) {
    return panic(
      "Migration table lock manifest does not match the bundled migrations",
    );
  }
  for (const { name, hash } of migrations) {
    const entry = manifest.migrations[name];
    if (!entry || entry.hash !== hash) {
      return panic(
        `Migration table lock manifest has no matching entry for ${name}`,
      );
    }
  }
  return manifest;
};

export const readMigrationLockManifest = (
  migrationsFolder: string,
  migrations: readonly BundledMigration[],
) => {
  const value: unknown = JSON.parse(
    readFileSync(
      path.join(migrationsFolder, MIGRATION_LOCK_MANIFEST_FILE),
      "utf-8",
    ),
  );
  return parseMigrationLockManifest({ value, migrations });
};

export const pendingMigrationLockTables = (
  manifest: MigrationLockManifest,
  pendingNames: readonly string[],
) => {
  const relations = new Set<string>();
  for (const name of pendingNames) {
    const entry = manifest.migrations[name];
    if (!entry) {
      return panic(`Migration table lock manifest has no entry for ${name}`);
    }
    for (const { relation } of entry.locks) {
      relations.add(relation);
    }
  }
  return [...relations].toSorted();
};

/** Dynamic SQL dependencies reserve every table and name that conservative choice. */
export const reportWildcardMigrationLocks = (
  manifest: MigrationLockManifest,
  pendingNames: readonly string[],
) => {
  for (const name of pendingNames) {
    const entry =
      manifest.migrations[name] ??
      panic(`Migration table lock manifest has no entry for ${name}`);
    if (entry.locks.some(({ relation }) => relation === "*")) {
      process.stdout.write(
        `${JSON.stringify({ event: "migrate.table_lease_wildcard", migration: name })}\n`,
      );
    }
  }
};
