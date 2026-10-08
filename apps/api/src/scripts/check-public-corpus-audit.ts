import { panic } from "better-result";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { schema } from "@/api/lib/db/public-corpus-audit/schema-catalog";
import {
  CORPUS_ATTESTATION_PATH,
  CORPUS_REPOSITORY_ROOT,
  corpusRepositoryInputs,
  readCorpusAttestations,
} from "@/api/lib/db/public-corpus-audit/attestation";
import { PUBLIC_CORPUS_BOOKKEEPING_TABLES } from "@/api/lib/db/public-corpus-audit/membership";
import {
  corpusDigest,
  verifyCorpusMigrations,
} from "@/api/lib/db/public-corpus-audit/migration-verification";
import { verifyPublicCorpusSchema } from "@/api/lib/db/public-corpus-audit/schema-verification";

const mode = process.argv.at(2);
if (mode !== "--check" && mode !== "--write") {
  panic("Expected --check or --write");
}
const inputs =
  PUBLIC_CORPUS_BOOKKEEPING_TABLES.length === 0
    ? { migrations: [], schemaDigest: "" }
    : corpusRepositoryInputs(CORPUS_REPOSITORY_ROOT);
const attestations = [];
const exportsByName = new Map(Object.entries(schema));
const names = new Set<string>();
for (const entry of PUBLIC_CORPUS_BOOKKEEPING_TABLES) {
  if (names.has(entry.sqlName)) {
    panic("Duplicate corpus relation");
  }
  names.add(entry.sqlName);
  const migration = verifyCorpusMigrations(entry, inputs.migrations);
  const errors = [
    ...verifyPublicCorpusSchema({ declaration: entry, schema }),
    ...migration.errors,
  ];
  const table = exportsByName.get(entry.schemaExport);
  if (is(table, PgTable)) {
    for (const column of getTableConfig(table).columns) {
      if (
        migration.columnTypes[column.name] !== column.getSQLType().toLowerCase()
      ) {
        errors.push("migration SQL column type differs from schema");
      }
    }
  }
  const module: unknown = await import(
    new URL(`../../../../${entry.moduleId}.ts`, import.meta.url).href
  );
  if (
    typeof module !== "object" ||
    module === null ||
    !(entry.schemaExport in module) ||
    Reflect.get(module, entry.schemaExport) !==
      exportsByName.get(entry.schemaExport)
  ) {
    errors.push("schema export does not belong to its declared module");
  }
  if (errors.length !== 0) {
    panic(`${entry.schemaExport}: ${errors.join("; ")}`);
  }
  attestations.push({
    schemaExport: entry.schemaExport,
    declarationDigest: corpusDigest(entry),
    schemaDigest: inputs.schemaDigest,
    migrationDigest: corpusDigest(inputs.migrations),
    statementDigest: corpusDigest(migration.relevant),
  });
}
if (mode === "--write") {
  writeFileSync(
    path.join(CORPUS_REPOSITORY_ROOT, CORPUS_ATTESTATION_PATH),
    `${JSON.stringify(attestations, null, 2)}\n`,
  );
} else if (
  JSON.stringify(readCorpusAttestations(CORPUS_REPOSITORY_ROOT)) !==
  JSON.stringify(attestations)
) {
  panic("Public corpus attestation is stale; verify with --write");
}
console.log(
  `public-corpus-audit: ${attestations.length} verified members (${mode})`,
);
