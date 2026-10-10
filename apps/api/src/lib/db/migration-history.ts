import { panic } from "better-result";
import { existsSync, readdirSync } from "node:fs";
import nodePath from "node:path";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

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
export type AppliedMigration = { name: string | null; hash: string };

type FindUnappliedMigrationsOptions = {
  appliedRows: readonly AppliedMigration[];
  localMigrations: LocalMigration[];
};

export const LEDGER_AHEAD_NAME_LIMIT = 20;

const acceptedHashesFor = ({
  name,
  hash,
}: LocalMigration): readonly string[] => {
  const supportedHistory = REWRITTEN_MIGRATION_HISTORIES[name];
  return supportedHistory?.currentHash === hash
    ? [hash, ...supportedHistory.priorHashes]
    : [hash];
};

export const summarizeLedgerAhead = ({
  appliedRows,
  localMigrations,
}: FindUnappliedMigrationsOptions) => {
  const bundledByName = new Map(
    localMigrations.map((migration) => [migration.name, migration]),
  );
  const unknown: string[] = [];
  const mismatched: string[] = [];
  for (const { name, hash } of appliedRows) {
    if (name === null) {
      continue;
    }
    const bundled = bundledByName.get(name);
    if (bundled === undefined) {
      unknown.push(name);
    } else if (!acceptedHashesFor(bundled).includes(hash)) {
      mismatched.push(name);
    }
  }
  return {
    unknownCount: unknown.length,
    newestUnknownName: unknown.toSorted().at(-1) ?? null,
    unknownNames: [...new Set(unknown)].toSorted(),
    mismatchCount: mismatched.length,
    mismatchedNames: [...new Set(mismatched)].toSorted(),
  };
};

export const findUnappliedMigrations = ({
  appliedRows,
  localMigrations,
}: FindUnappliedMigrationsOptions): LocalMigration[] => {
  const hashesByName = new Map<string, Set<string>>();
  // Counted, not a set: byte-identical migrations share a hash, and one
  // unnamed receipt must not prove that both of them ran.
  const unnamedHashCounts = new Map<string, number>();
  for (const { name, hash } of appliedRows) {
    if (name === null) {
      unnamedHashCounts.set(hash, (unnamedHashCounts.get(hash) ?? 0) + 1);
      continue;
    }
    const hashes = hashesByName.get(name);
    if (hashes === undefined) {
      hashesByName.set(name, new Set([hash]));
    } else {
      hashes.add(hash);
    }
  }

  const takeUnnamedReceipt = (acceptedHashes: readonly string[]): boolean => {
    const hash = acceptedHashes.find(
      (candidate) => (unnamedHashCounts.get(candidate) ?? 0) > 0,
    );
    if (hash === undefined) {
      return false;
    }
    unnamedHashCounts.set(hash, (unnamedHashCounts.get(hash) ?? 0) - 1);
    return true;
  };

  return localMigrations.filter(({ hash, name }) => {
    const acceptedHashes = acceptedHashesFor({ hash, name });
    const namedHashes = hashesByName.get(name);
    if (namedHashes !== undefined) {
      return !acceptedHashes.some((candidate) => namedHashes.has(candidate));
    }
    return !takeUnnamedReceipt(acceptedHashes);
  });
};

const hashMigrationFile = async (path: string): Promise<string> =>
  hashSha256Hex(await Bun.file(path).bytes());

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
  queryAppliedRows: () => Promise<readonly AppliedMigration[]>;
  remedy: string;
};

export const assertMigrationHistory = async ({
  context,
  migrationsDir,
  queryAppliedRows,
  remedy,
}: AssertMigrationHistoryOptions): Promise<void> => {
  const localMigrations = await listLocalMigrations(migrationsDir);
  if (localMigrations.length === 0) {
    panic(
      `[${context}] No migration files at ${migrationsDir}; refusing to continue. ` +
        "The runtime image must include apps/api/drizzle/.",
    );
  }

  const appliedRows = await queryAppliedRows();
  const ahead = summarizeLedgerAhead({ appliedRows, localMigrations });
  if (
    context === "startup" &&
    (ahead.unknownCount > 0 || ahead.mismatchCount > 0)
  ) {
    process.stdout.write(
      `${JSON.stringify({
        event: "migrate.ledger_ahead",
        level: "warn",
        unknownCount: ahead.unknownCount,
        newestUnknownName: ahead.newestUnknownName,
        unknownNames: ahead.unknownNames.slice(0, LEDGER_AHEAD_NAME_LIMIT),
        mismatchCount: ahead.mismatchCount,
        mismatchedNames: ahead.mismatchedNames.slice(
          0,
          LEDGER_AHEAD_NAME_LIMIT,
        ),
      })}\n`,
    );
  }
  const unapplied = findUnappliedMigrations({
    appliedRows,
    localMigrations,
  }).filter(
    ({ name }) =>
      context !== "startup" || !ahead.mismatchedNames.includes(name),
  );
  if (unapplied.length === 0) {
    return;
  }

  const unappliedNames = unapplied.map(({ name }) => name).join(", ");
  panic(
    `[${context}] Schema drift: ${unapplied.length} migration(s) in code are not applied to the database. ` +
      `Code has ${localMigrations.length}; DB has ${appliedRows.length}. ` +
      `Missing or modified after apply: ${unappliedNames}. ${remedy}`,
  );
};
