import { panic } from "better-result";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";

import type { Transaction } from "@/api/db/root";
import {
  legislationDocuments,
  legislationWorkIdentifiers,
} from "@/api/db/schema";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";

const WORK_IDENTIFIER_LIMIT = 64;
const WORK_IDENTIFIER_MAX_CHARS = 512;

/** Aliases are publisher assertions; citation grammars own normalization. */
export const syncLegislationWorkIdentifiersTx = async (
  tx: Transaction,
  { sourceId, eli, identifiers = [] }: LegislationDocumentInput,
) => {
  if (identifiers.length > WORK_IDENTIFIER_LIMIT) {
    panic("Too many legislation work identifiers");
  }
  const distinct = [...new Set([eli, ...identifiers])].toSorted(
    compareCodeUnit,
  );
  if (
    distinct.some(
      (identifier) =>
        identifier.length === 0 ||
        identifier.length > WORK_IDENTIFIER_MAX_CHARS,
    )
  ) {
    panic("Invalid legislation work identifier length");
  }
  const collision = (
    await tx
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .where(
        and(
          eq(legislationDocuments.sourceId, sourceId),
          inArray(legislationDocuments.eli, distinct),
          ne(legislationDocuments.eli, eli),
        ),
      )
      .limit(1)
  ).at(0);
  if (collision !== undefined) {
    panic("Legislation work identifier is another work's canonical identifier");
  }
  // audit: skip - publisher ingestion maintains derived public work identities
  const stored = await tx
    .insert(legislationWorkIdentifiers)
    .values(distinct.map((identifier) => ({ sourceId, eli, identifier })))
    .onConflictDoUpdate({
      target: [
        legislationWorkIdentifiers.sourceId,
        legislationWorkIdentifiers.identifier,
      ],
      set: { eli },
      setWhere: eq(legislationWorkIdentifiers.eli, eli),
    })
    .returning({ identifier: legislationWorkIdentifiers.identifier });
  if (stored.length !== distinct.length) {
    panic("Legislation work identifier already belongs to another work");
  }
};

/** The caller combines these keys with its document publication predicate. */
export const legislationWorkIdentifierCondition = async (
  tx: LegislationReadTransaction,
  identifier: string,
) => {
  const aliases = await tx
    .select({
      sourceId: legislationWorkIdentifiers.sourceId,
      eli: legislationWorkIdentifiers.eli,
    })
    .from(legislationWorkIdentifiers)
    .where(eq(legislationWorkIdentifiers.identifier, identifier))
    .limit(WORK_IDENTIFIER_LIMIT + 1);
  if (aliases.length > WORK_IDENTIFIER_LIMIT) {
    panic("Legislation work identifier exceeds source resolution limit");
  }
  const canonical = eq(legislationDocuments.eli, identifier);
  if (aliases.length === 0) {
    return canonical;
  }
  const targets = aliases.map(
    ({ sourceId, eli }) =>
      sql`(${legislationDocuments.sourceId} = ${sourceId} AND ${legislationDocuments.eli} = ${eli})`,
  );
  return sql`(${canonical} OR (${sql.join(targets, sql` OR `)}))`;
};
