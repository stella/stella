/**
 * What blending a case-law candidate needs, read off the engine's own hit
 * when the serving generation stores the ranking signals on every passage
 * (`case-law-ranking-signals.ts`): the row the per-candidate PostgreSQL read
 * used to return, without the read.
 *
 * Only blending stands on it. The page a request returns is still read from
 * PostgreSQL, which re-proves for those rows alone everything the index can
 * lag on: still published, no erasure queued, the copy still served, every
 * request filter, and the revision the excerpt is cut from.
 */
import type { SafeId } from "@/api/lib/branded-types";
import {
  CASE_LAW_RANKING_SIGNAL_FIELDS,
  CASE_LAW_RANKING_STORED_BASE_FIELDS,
  CITATION_AUTHORITY_BUCKET_MAX,
  citationAuthorityOfBucket,
  UNCITED_AUTHORITY_BUCKET,
} from "@/api/lib/legal-search/case-law-ranking-signals";
import type { ScannedProjection } from "@/api/lib/legal-search/corpus-index-pagination";
import type { CorpusProjectionRevision } from "@/api/lib/legal-search/corpus-index-revision-clause";
import {
  brandPersistedCaseLawDecisionId,
  brandValidatedCorpusIndexProjectionIntentId,
} from "@/api/lib/safe-id-boundaries";

/** The stored fields a ranking read asks the scored transport for. */
export const CASE_LAW_RANKING_SCAN_FIELDS: readonly string[] = [
  ...CASE_LAW_RANKING_STORED_BASE_FIELDS,
  ...Object.values(CASE_LAW_RANKING_SIGNAL_FIELDS),
];

/** The candidate row, in the shape the database read returns it. */
export type IndexedCaseLawCandidateRow = {
  id: SafeId<"caseLawDecision">;
  citationAuthority: number;
  court: string;
  country: string;
  courtId: string | null;
  languageGroupKey: string | null;
  appliedRevision: CorpusProjectionRevision;
  appliedGeneration: string;
  canRecur: boolean;
};

const optionalText = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const boundedInteger = (
  value: unknown,
  min: number,
  max: number,
): number | null =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max
    ? value
    : null;

/**
 * The candidate row a scanned passage stands for, or null when the hit does
 * not carry a well-formed signal set: such a hit is excluded, as a row the
 * database read did not return is, rather than ranked on a guess.
 *
 * Can recur exactly when the database read says it can: a decision of more
 * than one passage, or one whose language group another published decision
 * shares.
 */
export const indexedCaseLawCandidateRow = (
  id: string,
  projection: ScannedProjection,
  generation: string,
): IndexedCaseLawCandidateRow | null => {
  const { fields, revision } = projection;
  const appliedRevision =
    revision === null
      ? null
      : brandValidatedCorpusIndexProjectionIntentId(revision);
  const bucket = boundedInteger(
    fields[CASE_LAW_RANKING_SIGNAL_FIELDS.citationAuthorityBucket],
    UNCITED_AUTHORITY_BUCKET,
    CITATION_AUTHORITY_BUCKET_MAX,
  );
  const passageCount = boundedInteger(
    fields[CASE_LAW_RANKING_SIGNAL_FIELDS.passageCount],
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const shared = fields[CASE_LAW_RANKING_SIGNAL_FIELDS.languageGroupShared];
  const court = fields["court"];
  const country = fields["jurisdiction"];
  const courtId = optionalText(fields[CASE_LAW_RANKING_SIGNAL_FIELDS.courtId]);
  const languageGroupKey = optionalText(
    fields[CASE_LAW_RANKING_SIGNAL_FIELDS.languageGroupKey],
  );
  if (
    appliedRevision === null ||
    bucket === null ||
    passageCount === null ||
    typeof shared !== "boolean" ||
    typeof court !== "string" ||
    typeof country !== "string" ||
    courtId === undefined ||
    languageGroupKey === undefined
  ) {
    return null;
  }
  return {
    id: brandPersistedCaseLawDecisionId(id),
    citationAuthority: citationAuthorityOfBucket(bucket),
    court,
    country,
    courtId,
    languageGroupKey,
    appliedRevision,
    appliedGeneration: generation,
    canRecur: passageCount !== 1 || shared,
  };
};
