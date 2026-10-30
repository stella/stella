#!/usr/bin/env bun

import { panic } from "better-result";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { createSha256 } from "@stll/sha256/bun";

import aliasInventory from "../apps/api/src/lib/db/migration-alias-inventory.json" with { type: "json" };
import {
  findMalformedRequiresLines,
  findSortUnstableNames,
  validateRequires,
} from "../apps/api/src/lib/db/migration-ledger";
import {
  findMigrationTimestampViolations,
  MIGRATION_FILE,
  MIGRATION_TIMESTAMP,
  type MigrationIdentityChanges,
  readMigrationBaseSnapshot,
  runGit,
} from "./migration-restamp";

export {
  findMigrationTimestampViolations,
  readMigrationBaseSnapshot,
  readMigrationChanges,
} from "./migration-restamp";

type MigrationIdentityViolation =
  | { type: "invalid-name"; directory: string }
  | { type: "removed-base-migration"; directory: string }
  | { type: "stale-timestamp"; directory: string; newestBaseDirectory: string };

const HASH = /^[0-9a-f]{64}$/u;
const REPO_ROOT = path.resolve(import.meta.dir, "..");

export const findMigrationIdentityViolation = ({
  addedDirectories,
  removedDirectories,
}: MigrationIdentityChanges): MigrationIdentityViolation | null => {
  const directory = removedDirectories.at(0);
  if (directory !== undefined) {
    return { type: "removed-base-migration", directory };
  }
  for (const addedDirectory of addedDirectories) {
    if (!MIGRATION_TIMESTAMP.test(addedDirectory)) {
      return { type: "invalid-name", directory: addedDirectory };
    }
  }
  return null;
};

type AliasEntry = {
  fileName: string;
  priorHash: string;
  newHash: string;
  reason: string;
  repair: "none" | { indexes: readonly AliasIndex[] };
};

type AliasIndex = {
  definitionBody: string;
  isUnique: boolean;
  name: string;
  tableName: string;
};

type MigrationImmutabilityViolation =
  | { type: "inventory-mutated"; index: number }
  | { type: "alias-invalid"; detail: string }
  | { type: "edited-non-sql-in-base-folder"; file: string }
  | {
      type: "edited-base-migration";
      file: string;
      baseHash: string;
      headHash: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseAliasEntry = (value: unknown): AliasEntry | null => {
  if (!isRecord(value)) {
    return null;
  }
  const { fileName, priorHash, newHash, reason, repair } = value;
  if (
    typeof fileName !== "string" ||
    !MIGRATION_TIMESTAMP.test(fileName) ||
    typeof priorHash !== "string" ||
    !HASH.test(priorHash) ||
    typeof newHash !== "string" ||
    !HASH.test(newHash) ||
    priorHash === newHash ||
    typeof reason !== "string" ||
    reason.trim() === ""
  ) {
    return null;
  }
  if (repair === "none") {
    return { fileName, priorHash, newHash, reason, repair };
  }
  if (!isRecord(repair) || !Array.isArray(repair["indexes"])) {
    return null;
  }
  const indexes: AliasIndex[] = [];
  for (const rawIndex of repair["indexes"]) {
    if (
      !isRecord(rawIndex) ||
      typeof rawIndex["definitionBody"] !== "string" ||
      typeof rawIndex["isUnique"] !== "boolean" ||
      typeof rawIndex["name"] !== "string" ||
      typeof rawIndex["tableName"] !== "string"
    ) {
      return null;
    }
    indexes.push({
      definitionBody: rawIndex["definitionBody"],
      isUnique: rawIndex["isUnique"],
      name: rawIndex["name"],
      tableName: rawIndex["tableName"],
    });
  }
  return { fileName, priorHash, newHash, reason, repair: { indexes } };
};

export const findMigrationImmutabilityViolation = ({
  modifiedFiles,
  baseInventory,
  headInventory,
  baseHashes,
  headHashes,
}: {
  modifiedFiles: readonly string[];
  baseInventory: unknown;
  headInventory: unknown;
  baseHashes: Readonly<Record<string, string>>;
  headHashes: Readonly<Record<string, string>>;
}): MigrationImmutabilityViolation | null => {
  if (!Array.isArray(baseInventory) || !Array.isArray(headInventory)) {
    return { type: "alias-invalid", detail: "inventory must be an array" };
  }
  for (const [index, entry] of baseInventory.entries()) {
    if (!isDeepStrictEqual(entry, headInventory[index])) {
      return { type: "inventory-mutated", index };
    }
  }

  const entries: AliasEntry[] = [];
  const nextHashByFile = new Map<string, Map<string, string>>();
  const indexByFileAndName = new Map<string, AliasIndex>();
  for (const [index, rawEntry] of headInventory.entries()) {
    const entry = parseAliasEntry(rawEntry);
    if (entry === null) {
      return {
        type: "alias-invalid",
        detail: `invalid entry at index ${index}`,
      };
    }
    if (entry.repair !== "none") {
      for (const repairIndex of entry.repair.indexes) {
        const key = `${entry.fileName}:${repairIndex.name}`;
        const previous = indexByFileAndName.get(key);
        if (
          previous !== undefined &&
          !isDeepStrictEqual(previous, repairIndex)
        ) {
          return {
            type: "alias-invalid",
            detail: `conflicting index repair ${key}`,
          };
        }
        indexByFileAndName.set(key, repairIndex);
      }
    }
    const nextByPrior = nextHashByFile.get(entry.fileName) ?? new Map();
    nextByPrior.set(entry.priorHash, entry.newHash);
    nextHashByFile.set(entry.fileName, nextByPrior);
    entries.push(entry);
  }
  for (const entry of entries) {
    const file = `apps/api/drizzle/${entry.fileName}/migration.sql`;
    const currentHash = headHashes[file];
    if (currentHash === undefined) {
      return {
        type: "alias-invalid",
        detail: `${entry.fileName} has no valid bundled hash chain`,
      };
    }
    const nextByPrior = nextHashByFile.get(entry.fileName);
    let hash = entry.priorHash;
    const seen = new Set<string>();
    while (hash !== currentHash) {
      if (seen.has(hash)) {
        return {
          type: "alias-invalid",
          detail: `${entry.fileName} has a cycle`,
        };
      }
      seen.add(hash);
      const next = nextByPrior?.get(hash);
      if (next === undefined) {
        return {
          type: "alias-invalid",
          detail: `${entry.fileName}:${entry.priorHash} does not reach the bundled hash`,
        };
      }
      hash = next;
    }
  }

  const appended = entries.slice(baseInventory.length);
  for (const file of modifiedFiles) {
    if (!MIGRATION_FILE.test(file)) {
      return { type: "edited-non-sql-in-base-folder", file };
    }
    const baseHash = baseHashes[file];
    const headHash = headHashes[file];
    if (baseHash === undefined || headHash === undefined) {
      panic(`Missing committed migration hash for ${file}`);
    }
    const fileName = path.posix.basename(path.posix.dirname(file));
    if (
      !appended.some(
        (entry) =>
          entry.fileName === fileName &&
          entry.priorHash === baseHash &&
          entry.newHash === headHash,
      )
    ) {
      return { type: "edited-base-migration", file, baseHash, headHash };
    }
  }
  return null;
};

const readGitFile = ({
  ref,
  file,
  cwd,
}: {
  ref: string;
  file: string;
  cwd: string;
}): Uint8Array => runGit({ arguments_: ["show", `${ref}:${file}`], cwd });

export const hashBytes = (bytes: Uint8Array): string =>
  createSha256().update(bytes).digest("hex");

export const formatAliasSummary = (
  entries: readonly {
    fileName: string;
    priorHash: string;
    newHash: string;
    reason: string;
    repair: string | { indexes: readonly { name: string }[] };
  }[],
): string => {
  const cell = (value: string): string =>
    value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
  const rows = entries.map(
    ({ fileName, priorHash, newHash, reason, repair }) => {
      const repairText =
        typeof repair === "string"
          ? repair
          : repair.indexes.map(({ name }) => name).join(", ");
      return `| ${cell(fileName)} | ${priorHash} | ${newHash} | ${cell(reason)} | ${cell(repairText)} |`;
    },
  );
  return [
    "\n### Migration aliases\n",
    "| File | Prior hash | New hash | Reason | Repair |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
};

if (import.meta.main) {
  const baseRef = Bun.argv.at(2);
  if (baseRef === undefined) {
    panic("Usage: bun scripts/check-migration-order.ts <base-ref>");
  }

  const { changes, baseInventory, baseHashes, baseDirectories } =
    readMigrationBaseSnapshot({
      baseRef,
      cwd: REPO_ROOT,
    });
  const violation = findMigrationIdentityViolation(changes);
  if (violation?.type === "invalid-name") {
    panic(
      `New migration directory must start with a 14-digit timestamp: ${violation.directory}`,
    );
  }
  if (violation?.type === "removed-base-migration") {
    panic(
      `Migration directory ${violation.directory} was removed. The folder name is ` +
        `the migration's identity in the deployed ledger. Renaming a merged ` +
        `migration makes deployed databases re-run it under the new name; deleting ` +
        `it removes it from fresh databases. Add a new migration instead.`,
    );
  }

  const timestampViolations = findMigrationTimestampViolations({
    addedDirectories: changes.addedDirectories,
    baseDirectories,
  });
  if (timestampViolations.length > 0) {
    panic(
      timestampViolations
        .map(
          ({ directory, newestBaseDirectory }) =>
            `New migration ${directory} must be stamped later than the newest base migration ${newestBaseDirectory}. Re-stamp the unmerged migration later than that one; never re-stamp a merged migration.`,
        )
        .join("\n"),
    );
  }

  const inventorySqlFiles = aliasInventory.map(
    ({ fileName }) => `apps/api/drizzle/${fileName}/migration.sql`,
  );
  const headHashes: Record<string, string> = {};
  for (const file of new Set([
    ...Object.keys(baseHashes),
    ...inventorySqlFiles,
  ])) {
    headHashes[file] = hashBytes(
      readGitFile({ ref: "HEAD", file, cwd: REPO_ROOT }),
    );
  }
  const immutabilityViolation = findMigrationImmutabilityViolation({
    modifiedFiles: changes.modifiedFiles,
    baseInventory,
    headInventory: aliasInventory,
    baseHashes,
    headHashes,
  });
  if (immutabilityViolation !== null) {
    panic(
      `Migration immutability violation: ${JSON.stringify(immutabilityViolation)}`,
    );
  }

  const migrationsFolder = path.join(REPO_ROOT, "apps/api/drizzle");
  const bundle = readMigrationFiles({ migrationsFolder });
  const changedMigrationSqlFiles = new Set([
    ...changes.addedDirectories.map(
      (directory) => `${directory}/migration.sql`,
    ),
    ...changes.modifiedFiles.filter((file) => MIGRATION_FILE.test(file)),
  ]);
  for (const file of changedMigrationSqlFiles) {
    const sqlText = new TextDecoder("utf-8", { fatal: true }).decode(
      readGitFile({ ref: "HEAD", file, cwd: REPO_ROOT }),
    );
    const malformed = findMalformedRequiresLines(sqlText);
    if (malformed.length > 0) {
      panic(
        `Malformed migration dependency in ${file}: ${JSON.stringify(malformed)}`,
      );
    }
  }
  const dependencyViolations = validateRequires({
    bundle,
    appliedNames: new Set(),
  });
  if (dependencyViolations.length > 0) {
    panic(
      `Migration dependency violation: ${JSON.stringify(dependencyViolations)}`,
    );
  }
  const unstableNames = findSortUnstableNames({
    bundle,
    addedNames: new Set(
      changes.addedDirectories.map((directory) =>
        path.posix.basename(directory),
      ),
    ),
  });
  if (unstableNames.length > 0) {
    panic(
      `Migration names have unstable sort positions: ${unstableNames.join(", ")}`,
    );
  }

  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath !== undefined && Array.isArray(baseInventory)) {
    const appended = aliasInventory.slice(baseInventory.length);
    if (appended.length > 0) {
      appendFileSync(summaryPath, formatAliasSummary(appended));
    }
  }
}
