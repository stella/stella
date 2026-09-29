import { panic } from "better-result";
import { existsSync, readdirSync } from "node:fs";
import nodePath from "node:path";

import migrationAliasInventory from "./migration-alias-inventory.json";

// Migrations intentionally rewritten after they shipped in a release. A
// database that applied the earlier version recorded its hash, and the
// migrator never re-runs an already-applied folder, so the rewritten hash is
// never stored. Accept the prior hash as satisfying the check for these.
type RewrittenMigrationHistory = {
  currentHash: string;
  priorHashes: readonly string[];
  requiredIndexes: readonly RequiredMigrationIndex[];
};

export type RequiredMigrationIndex = {
  definitionBody: string;
  isUnique: boolean;
  name: string;
  tableName: string;
};

type MigrationAliasEntry = {
  fileName: string;
  priorHash: string;
  newHash: string;
  repair: string | { indexes: readonly RequiredMigrationIndex[] };
};

export const deriveMigrationAliasHistory = (
  inventory: readonly MigrationAliasEntry[],
) => {
  const histories: Record<
    string,
    {
      currentHash: string;
      priorHashes: string[];
      requiredIndexes: RequiredMigrationIndex[];
    }
  > = {};
  const indexesByName = new Map<string, RequiredMigrationIndex>();

  for (const { fileName, priorHash, newHash, repair } of inventory) {
    let history = histories[fileName];
    if (history === undefined) {
      history = { currentHash: newHash, priorHashes: [], requiredIndexes: [] };
      histories[fileName] = history;
    }
    history.currentHash = newHash;
    history.priorHashes.push(priorHash);

    if (typeof repair === "string") {
      if (repair !== "none") {
        panic(`Unknown migration alias repair: ${repair}`);
      }
      continue;
    }
    for (const index of repair.indexes) {
      const existing = history.requiredIndexes.find(
        ({ name }) => name === index.name,
      );
      if (
        existing !== undefined &&
        (existing.definitionBody !== index.definitionBody ||
          existing.isUnique !== index.isUnique ||
          existing.tableName !== index.tableName)
      ) {
        panic(`Conflicting migration alias index ${index.name} in ${fileName}`);
      }
      if (existing === undefined) {
        history.requiredIndexes.push(index);
      }
      indexesByName.set(index.name, index);
    }
  }
  return { histories, indexes: [...indexesByName.values()] };
};

const {
  histories: rewrittenMigrationHistories,
  indexes: rewrittenMigrationIndexes,
} = deriveMigrationAliasHistory(migrationAliasInventory);

export const REWRITTEN_MIGRATION_HISTORIES: Readonly<
  Record<string, RewrittenMigrationHistory>
> = rewrittenMigrationHistories;

export const REWRITTEN_MIGRATION_INDEXES: readonly RequiredMigrationIndex[] = [
  ...rewrittenMigrationIndexes,
];

export type LocalMigration = { name: string; hash: string };

type FindUnappliedMigrationsOptions = {
  appliedHashes: ReadonlySet<string>;
  localMigrations: LocalMigration[];
};

export const findUnappliedMigrations = ({
  appliedHashes,
  localMigrations,
}: FindUnappliedMigrationsOptions): LocalMigration[] =>
  localMigrations.filter(({ hash, name }) => {
    if (appliedHashes.has(hash)) {
      return false;
    }
    const supportedHistory = REWRITTEN_MIGRATION_HISTORIES[name];
    if (supportedHistory?.currentHash !== hash) {
      return true;
    }
    return !supportedHistory.priorHashes.some((priorHash) =>
      appliedHashes.has(priorHash),
    );
  });

const hashMigrationFile = async (path: string): Promise<string> =>
  new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).bytes())
    .digest("hex");

const listLocalMigrations = async (
  migrationsDir: string,
): Promise<LocalMigration[]> => {
  if (!existsSync(migrationsDir)) {
    return [];
  }
  return await Promise.all(
    readdirSync(migrationsDir)
      .filter((name) =>
        existsSync(nodePath.join(migrationsDir, name, "migration.sql")),
      )
      .toSorted()
      .map(async (name) => ({
        name,
        hash: await hashMigrationFile(
          nodePath.join(migrationsDir, name, "migration.sql"),
        ),
      })),
  );
};

type AssertMigrationHistoryOptions = {
  context: "migrate" | "startup";
  migrationsDir: string;
  queryAppliedHashes: () => Promise<ReadonlySet<string>>;
  remedy: string;
};

export const assertMigrationHistory = async ({
  context,
  migrationsDir,
  queryAppliedHashes,
  remedy,
}: AssertMigrationHistoryOptions): Promise<void> => {
  const localMigrations = await listLocalMigrations(migrationsDir);
  if (localMigrations.length === 0) {
    panic(
      `[${context}] No migration files at ${migrationsDir}; refusing to continue. ` +
        "The runtime image must include apps/api/drizzle/.",
    );
  }

  const appliedHashes = await queryAppliedHashes();
  const unapplied = findUnappliedMigrations({
    appliedHashes,
    localMigrations,
  });
  if (unapplied.length === 0) {
    return;
  }

  const unappliedNames = unapplied.map(({ name }) => name).join(", ");
  panic(
    `[${context}] Schema drift: ${unapplied.length} migration(s) in code are not applied to the database. ` +
      `Code has ${localMigrations.length}; DB has ${appliedHashes.size}. ` +
      `Missing or modified after apply: ${unappliedNames}. ${remedy}`,
  );
};
