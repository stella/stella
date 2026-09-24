/**
 * The record an absorbed supplement row keeps of the judgment it went into.
 *
 * Ingestion absorbs a standalone supplement row once its judgment composes it
 * (`supplement-absorption.ts`): the row keeps its id, loses its document and
 * publication, and names the judgment here. Public reads of that id follow
 * the record to the judgment, so every link, bookmark and citation of the
 * old id keeps resolving. One owner for the stored shape, because the writer,
 * the fold's selection and the public gate all read it.
 *
 * The record lives in the row's metadata, beside the listing-only marker the
 * absorption sets in the same statement: an observation that makes the row a
 * decision again replaces the metadata, and with it both, so the row cannot
 * be published and absorbed at once.
 */
import type { Column, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import {
  DECISION_SUPPLEMENT_KINDS,
  type DecisionSupplementKind,
} from "@/api/lib/legal-search/decision-supplement-kind";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/** Pipeline-owned metadata key of the record. */
export const ABSORBED_INTO_METADATA_KEY = "_stellaAbsorbedInto";

type DecisionAbsorption = {
  /** The judgment the row went into. */
  decisionId: SafeId<"caseLawDecision">;
  kind: DecisionSupplementKind;
  /**
   * The supplement's publisher id, which is also the row's own. Kept in the
   * record so a public read can address the supplement's blocks in the
   * judgment without being granted the row's publisher id column.
   */
  sourceDocumentId: string;
};

const isDecisionSupplementKind = (
  value: unknown,
): value is DecisionSupplementKind =>
  DECISION_SUPPLEMENT_KINDS.some((kind) => kind === value);

/** The stored record, or null when the value is not one. */
export const readDecisionAbsorption = (
  marker: unknown,
): DecisionAbsorption | null => {
  if (!isRecord(marker)) {
    return null;
  }
  const { decisionId, kind, sourceDocumentId } = marker;
  return typeof decisionId === "string" &&
    isDecisionSupplementKind(kind) &&
    typeof sourceDocumentId === "string"
    ? {
        decisionId: brandPersistedCaseLawDecisionId(decisionId),
        kind,
        sourceDocumentId,
      }
    : null;
};

/** The record as a SQL value: NULL on every row that was never absorbed. */
export const decisionAbsorptionSql = (metadata: Column): SQL =>
  sql`${metadata} -> ${sql.raw(`'${ABSORBED_INTO_METADATA_KEY}'`)}`;

/** The metadata with the record written, as a SQL value. */
export const metadataWithDecisionAbsorption = (
  metadata: SQL,
  { decisionId, kind, sourceDocumentId }: DecisionAbsorption,
): SQL =>
  sql`jsonb_set(${metadata}, ${sql.raw(`'{${ABSORBED_INTO_METADATA_KEY}}'`)}, jsonb_build_object('decisionId', ${decisionId}::text, 'kind', ${kind}::text, 'sourceDocumentId', ${sourceDocumentId}::text))`;

type SupplementAnchorPrefixOptions = Pick<
  DecisionAbsorption,
  "kind" | "sourceDocumentId"
>;

/**
 * The prefix a supplement's block ids and anchors take inside its judgment's
 * document. Both documents number their blocks from one; the prefix keeps
 * them apart, and maps an anchor into the standalone row onto the same block
 * in the judgment.
 */
export const supplementAnchorPrefix = ({
  kind,
  sourceDocumentId,
}: SupplementAnchorPrefixOptions): string => `${kind}-${sourceDocumentId}-`;
