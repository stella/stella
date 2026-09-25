import { panic } from "better-result";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
} from "@/api/db/schema";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { segmentDecision } from "@/api/handlers/case-law/ingestion/segmenter";
import { pgPayloadCarriesDocument } from "@/api/handlers/case-law/stored-payload";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import {
  corpusMirrorColumns,
  corpusPayloadDisposition,
  EMPTY_CORPUS_CONTENT_HASHES,
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
} from "@/api/lib/legal-search/corpus-storage";
import type {
  CorpusPayload,
  WriteCorpusResult,
} from "@/api/lib/legal-search/corpus-storage";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";

/**
 * Where this decision's canonical payload ends up.
 *
 * - `postgres-only` the row carries text/sections/AST and nothing mirrors
 *   it, so any corpus pointers left over from an earlier mode are stale.
 * - `postgres-mirrored` the row carries the payload while its durable upload
 *   intent refreshes the corpus pointers under a compare-and-set.
 * - `object-storage` uses the same pending representation, then clears the
 *   Postgres payload atomically when the durable upload settles.
 */
export type CorpusWritePlan =
  | { type: "postgres-only" }
  | { type: "postgres-mirrored" }
  | { type: "object-storage" }
  | { type: "preserve-stored" };

export type CorpusWritePayload = CorpusPayload & {
  documentId: SafeId<"caseLawDecision">;
  jurisdiction: string;
};

type SettleCaseLawCorpusMirrorTxOptions = {
  decisionId: SafeId<"caseLawDecision">;
  persistedSourceHash: string | null;
  observationOrder: bigint;
  mirrorCarriesDocument: boolean;
  mode: CorpusStorageMode;
  /** Null when the payload carried no document and nothing was stored. */
  written: WriteCorpusResult | null;
  tx: Transaction;
};

/**
 * Settle only the observation that owns the pending mirror.
 *
 * A missed compare-and-set is retryable, not terminal: another run may still
 * leave the durable row pending, so the caller's page cursor must stay held
 * until a replay proves the mirror settled.
 */
export const settleCaseLawCorpusMirrorTx = async ({
  decisionId,
  persistedSourceHash,
  observationOrder,
  mirrorCarriesDocument,
  mode,
  tx,
  written,
}: SettleCaseLawCorpusMirrorTxOptions): Promise<boolean> => {
  // audit: skip — background corpus storage; derived state, not user actions
  const settled = await tx
    .update(caseLawDecisions)
    .set({
      // Read off the storage mode rather than off the write plan: the plan
      // is derived from the mode, and a second derivation here is a mirror
      // that can go stale.
      ...(corpusPayloadDisposition({ mode, written }) === "trim"
        ? TRIMMED_CORPUS_PAYLOAD_COLUMNS
        : {}),
      ...corpusMirrorColumns({
        status: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        written,
      }),
    })
    .where(
      and(
        eq(caseLawDecisions.id, decisionId),
        sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${persistedSourceHash}`,
        eq(caseLawDecisions.sourceObservationOrder, observationOrder),
        eq(
          caseLawDecisions.corpusMirrorStatus,
          CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
        ),
        isNull(caseLawDecisions.redactedAt),
        mirrorCarriesDocument
          ? undefined
          : sql`NOT ${pgPayloadCarriesDocument}`,
      ),
    )
    .returning({ id: caseLawDecisions.id });
  return settled.length > 0;
};

/**
 * SQL for "this row holds a document", in the columns or in the corpus
 * objects its hash names. The row write below carries this in its WHERE,
 * where it is evaluated with the write and cannot go stale.
 */
export const rowHoldsDocument = sql<boolean>`(
  ${pgPayloadCarriesDocument}
  or (
    ${caseLawDecisions.contentHash} is not null
    and ${notInArray(caseLawDecisions.contentHash, [...EMPTY_CORPUS_CONTENT_HASHES])}
  )
)`;

/**
 * The columns a refresh compares against the stored row before writing them,
 * and the SQL type each one is bound as for that comparison. A key that is
 * not a decision column fails to typecheck where `storedRowDiffers` reads it
 * off the table.
 */
const REFRESH_COMPARED_COLUMN_TYPES = {
  caseNumber: "text",
  citationKey: "text",
  sourceDocumentId: "text",
  ecli: "text",
  court: "text",
  country: "text",
  language: "text",
  sheetNumber: "text",
  languageGroupKey: "text",
  decisionDate: "date",
  decisionType: "text",
  sourceUrl: "text",
  documentUrl: "text",
  parserVersion: "smallint",
  fulltext: "text",
  sections: "jsonb",
  documentAst: "jsonb",
  corpusMirrorStatus: "text",
  textS3Key: "text",
  normalizedS3Key: "text",
  astS3Key: "text",
  contentHash: "text",
} as const;

type RefreshComparedColumn = keyof typeof REFRESH_COMPARED_COLUMN_TYPES;

const isRefreshComparedColumn = (key: string): key is RefreshComparedColumn =>
  Object.hasOwn(REFRESH_COMPARED_COLUMN_TYPES, key);

/**
 * A value as the comparison binds it. jsonb goes through `::text::jsonb`,
 * never a bare `::jsonb`: the cast fixes the bind parameter's type, and the
 * driver would then JSON-encode the already-serialized string.
 */
const boundRefreshValue = (
  column: RefreshComparedColumn,
  value: unknown,
): SQL => {
  const type = REFRESH_COMPARED_COLUMN_TYPES[column];
  if (value === null) {
    return sql`NULL::${sql.raw(type)}`;
  }
  return type === "jsonb"
    ? sql`${JSON.stringify(value)}::text::jsonb`
    : sql`${value}::${sql.raw(type)}`;
};

/**
 * SQL for "writing these values would change the stored row". A key whose
 * value is `undefined` is skipped, as the update itself skips it.
 */
export const storedRowDiffers = (values: Record<string, unknown>): SQL => {
  const terms = Object.entries(values).flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }
    if (!isRefreshComparedColumn(key)) {
      return panic(`Refresh cannot compare column ${key}`);
    }
    return [
      sql`${caseLawDecisions[key]} IS DISTINCT FROM ${boundRefreshValue(key, value)}`,
    ];
  });
  return terms.length === 0 ? sql`false` : sql`(${sql.join(terms, sql` OR `)})`;
};

/**
 * SQL for "writing this payload changes what the decision says". A
 * preserved payload says what it said: trimming it to the corpus is a change
 * of storage, not of the decision. A written document is taken as changed
 * rather than compared, which would read megabytes to learn it.
 */
export const payloadChangedSql = (
  plan: CorpusWritePlan,
  written: Record<string, unknown>,
): SQL => {
  if (plan.type === "preserve-stored") {
    return sql`false`;
  }
  return "fulltext" in written ? sql`true` : storedRowDiffers(written);
};

/**
 * The same question, asked ahead of the write. Answered as a boolean
 * rather than by pulling the payload across: the text can be megabytes
 * and this runs inside the crawl.
 *
 * This answer is advisory: it decides whether to spend a corpus write
 * and whether to report an empty decision, neither of which can be made
 * conditional inside the row update. The guarantee that a document is
 * not overwritten lives in that update's WHERE clause, so a backfill
 * committing between this read and the write loses nothing.
 */
export const hasStoredDocument = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<boolean> => {
  const [row] = await scopedDb((tx) =>
    tx
      .select({ holdsDocument: rowHoldsDocument })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId))
      .limit(1),
  );

  return row?.holdsDocument === true;
};

type PendingMirrorPayload = Pick<
  CorpusWritePayload,
  "ast" | "sections" | "text"
> & {
  sourceObservationHash: string | null;
  sourceObservationOrder: bigint | null;
};

export const loadPendingMirrorPayload = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<PendingMirrorPayload> => {
  const row = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: {
        documentAst: true,
        fulltext: true,
        sections: true,
        sourceObservationHash: true,
        sourceObservationOrder: true,
      },
    }),
  );
  if (!row) {
    panic("Pending case-law corpus mirror disappeared");
  }
  return {
    ast: row.documentAst,
    sections: row.sections,
    sourceObservationHash: row.sourceObservationHash,
    sourceObservationOrder: row.sourceObservationOrder,
    text: row.fulltext,
  };
};

/**
 * Structural sections for a result: the parser's own where it recovered
 * them, otherwise derived from the flattened text. Structure-derived
 * sections win — an adapter supplies them only when its parser recovered
 * the document's own headings, which is strictly better than re-deriving
 * boundaries from flattened text.
 *
 * One definition, because the stored payload's identity depends on it: a
 * second derivation elsewhere would hash a different document than the one
 * this pipeline stores.
 */
export const decisionSections = (result: IngestionResult): DecisionSection[] =>
  result.sections ?? (result.fulltext ? segmentDecision(result.fulltext) : []);

/**
 * The canonical payload a result stores, in the shape the content hash is
 * taken over. Exported so a caller comparing a re-parse against what is
 * already stored asks the same question the corpus write does.
 */
export const caseLawCanonicalPayload = (
  result: IngestionResult,
): CorpusPayload => {
  const sections = decisionSections(result);
  return {
    ast: result.documentAst,
    sections: sections.length > 0 ? sections : null,
    text: result.fulltext ?? null,
  };
};

export const planCorpusWrite = (mode: CorpusStorageMode): CorpusWritePlan => {
  switch (mode) {
    case "off":
      return { type: "postgres-only" };
    case "dual-write":
      return { type: "postgres-mirrored" };
    case "canonical":
      return { type: "object-storage" };
    default: {
      mode satisfies never;
      return panic(`Unhandled corpus storage mode: ${String(mode)}`);
    }
  }
};
