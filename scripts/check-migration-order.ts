#!/usr/bin/env bun

import { panic } from "better-result";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import aliasInventory from "../apps/api/src/lib/db/migration-alias-inventory.json" with { type: "json" };
import {
  findMalformedRequiresLines,
  findSortUnstableNames,
  validateRequires,
} from "../apps/api/src/lib/db/migration-ledger";

type MigrationIdentityViolation =
  | { type: "invalid-name"; directory: string }
  | { type: "removed-base-migration"; directory: string };

type MigrationIdentityChanges = {
  addedDirectories: readonly string[];
  removedDirectories: readonly string[];
};

type MigrationChanges = MigrationIdentityChanges & {
  modifiedFiles: readonly string[];
};

const MIGRATION_TIMESTAMP = /(?:^|\/)([0-9]{14})_[^/]+$/u;
const MIGRATION_FILE = /^apps\/api\/drizzle\/[^/]+\/migration\.sql$/u;
const MIGRATION_FOLDER_FILE = /^apps\/api\/drizzle\/[^/]+\/.+$/u;
const ALIAS_INVENTORY_PATH =
  "apps/api/src/lib/db/migration-alias-inventory.json";
const HASH = /^[0-9a-f]{64}$/u;
const REPO_ROOT = path.resolve(import.meta.dir, "..");

const runGit = ({
  arguments_,
  cwd,
}: {
  arguments_: readonly string[];
  cwd: string;
}): Uint8Array => {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(
      `git ${arguments_.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout;
};

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

export const readMigrationChanges = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}): MigrationChanges => {
  const arguments_ = [
    "diff",
    "--no-renames",
    "--name-status",
    `${baseRef}...HEAD`,
    "--",
    "apps/api/drizzle",
  ];
  const addedDirectories: string[] = [];
  const removedDirectories: string[] = [];
  const modifiedFiles: string[] = [];
  for (const line of new TextDecoder()
    .decode(runGit({ arguments_, cwd }))
    .split("\n")) {
    const [status, filename] = line.split("\t");
    if (filename === undefined) {
      continue;
    }
    if (status !== "A" && status !== "D" && status !== "M") {
      panic(
        `Unsupported migration change status ${String(status)} for ${filename}`,
      );
    }
    if (status === "M" && MIGRATION_FOLDER_FILE.test(filename)) {
      modifiedFiles.push(filename);
      continue;
    }
    if (!MIGRATION_FILE.test(filename)) {
      continue;
    }
    const directory = path.posix.dirname(filename);
    if (status === "A") {
      addedDirectories.push(directory);
    } else if (status === "D") {
      removedDirectories.push(directory);
    }
  }
  return { addedDirectories, removedDirectories, modifiedFiles };
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

const readBaseInventory = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}): unknown => {
  const files = new TextDecoder()
    .decode(
      runGit({
        arguments_: [
          "ls-tree",
          "--name-only",
          baseRef,
          "--",
          ALIAS_INVENTORY_PATH,
        ],
        cwd,
      }),
    )
    .trim();
  if (files === "") {
    return [];
  }
  if (files !== ALIAS_INVENTORY_PATH) {
    panic(`Unexpected base inventory path: ${files}`);
  }
  return JSON.parse(
    new TextDecoder().decode(
      readGitFile({ ref: baseRef, file: ALIAS_INVENTORY_PATH, cwd }),
    ),
  );
};

export const readMigrationBaseSnapshot = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}) => {
  const mergeBase = new TextDecoder()
    .decode(runGit({ arguments_: ["merge-base", baseRef, "HEAD"], cwd }))
    .trim();
  const changes = readMigrationChanges({ baseRef: mergeBase, cwd });
  const baseInventory = readBaseInventory({ baseRef: mergeBase, cwd });
  const baseHashes: Record<string, string> = {};
  for (const file of changes.modifiedFiles.filter((candidate) =>
    MIGRATION_FILE.test(candidate),
  )) {
    baseHashes[file] = hashSha256Hex(
      readGitFile({ ref: mergeBase, file, cwd }),
    );
  }
  return { mergeBase, changes, baseInventory, baseHashes };
};

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

  const { changes, baseInventory, baseHashes } = readMigrationBaseSnapshot({
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

  const inventorySqlFiles = aliasInventory.map(
    ({ fileName }) => `apps/api/drizzle/${fileName}/migration.sql`,
  );
  const headHashes: Record<string, string> = {};
  for (const file of new Set([
    ...Object.keys(baseHashes),
    ...inventorySqlFiles,
  ])) {
    headHashes[file] = hashSha256Hex(
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
