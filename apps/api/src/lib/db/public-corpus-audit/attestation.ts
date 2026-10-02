import { Result } from "better-result";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_CORPUS_BOOKKEEPING_TABLES } from "./membership.ts";
import {
  corpusDigest,
  verifiedCorpusMembership,
} from "./migration-verification.ts";
import type {
  CorpusAttestation,
  CorpusMigration,
} from "./migration-verification.ts";

export const CORPUS_ATTESTATION_PATH =
  "apps/api/src/lib/db/public-corpus-audit/attestation.json";
export const CORPUS_REPOSITORY_ROOT = fileURLToPath(
  new URL("../../../../../../", import.meta.url),
);

const sourceFiles = (root: string, directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, directory), {
    withFileTypes: true,
  })) {
    if (
      entry.name.startsWith(".") ||
      ["node_modules", "dist", "build", "coverage"].includes(entry.name)
    ) {
      continue;
    }
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...sourceFiles(root, relative));
    } else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
};

export const corpusRepositoryInputs = (root: string) => {
  const migrations: CorpusMigration[] = [];
  const directory = path.join(root, "apps/api/drizzle");
  for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted(
    (a, b) => {
      if (a.name < b.name) {
        return -1;
      }
      if (a.name > b.name) {
        return 1;
      }
      return 0;
    },
  )) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = `apps/api/drizzle/${entry.name}/migration.sql`;
    migrations.push({
      file,
      sql: readFileSync(path.join(root, file), "utf-8"),
    });
  }
  // The schema can depend transitively on application/package helpers. Hash a
  // conservative superset, including the lockfile and verifier implementation.
  const files = [
    ...sourceFiles(root, "apps/api/src"),
    ...sourceFiles(root, "packages"),
    "bun.lock",
  ].toSorted();
  const schemaDigest = corpusDigest(
    files.map((file) => [file, readFileSync(path.join(root, file), "utf-8")]),
  );
  return { migrations, schemaDigest };
};

const isAttestation = (value: unknown): value is CorpusAttestation =>
  typeof value === "object" &&
  value !== null &&
  "schemaExport" in value &&
  typeof value.schemaExport === "string" &&
  "declarationDigest" in value &&
  typeof value.declarationDigest === "string" &&
  "schemaDigest" in value &&
  typeof value.schemaDigest === "string" &&
  "migrationDigest" in value &&
  typeof value.migrationDigest === "string" &&
  "statementDigest" in value &&
  typeof value.statementDigest === "string";

export const readCorpusAttestations = (
  root: string,
): CorpusAttestation[] | null => {
  const value: unknown = JSON.parse(
    readFileSync(path.join(root, CORPUS_ATTESTATION_PATH), "utf-8"),
  );
  if (!Array.isArray(value) || !value.every(isAttestation)) {
    return null;
  }
  return value;
};

let verified: ReturnType<typeof verifiedCorpusMembership> | undefined;
export const readVerifiedCorpusMembership = () => {
  if (verified !== undefined) {
    return verified;
  }
  if (PUBLIC_CORPUS_BOOKKEEPING_TABLES.length === 0) {
    return [];
  }
  const result = Result.try(() => {
    const attestations = readCorpusAttestations(CORPUS_REPOSITORY_ROOT);
    if (attestations === null) {
      return [];
    }
    return verifiedCorpusMembership({
      entries: PUBLIC_CORPUS_BOOKKEEPING_TABLES,
      attestations,
      ...corpusRepositoryInputs(CORPUS_REPOSITORY_ROOT),
    });
  });
  // Unreadable inputs and stale attestations keep every mutation audit-required.
  verified = result.isOk() ? result.value : [];
  return verified;
};
