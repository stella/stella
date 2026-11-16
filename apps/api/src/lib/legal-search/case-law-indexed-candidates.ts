/**
 * What blending a case-law candidate needs, read off the engine's own hit
 * when the serving generation stores the ranking signals on every passage
 * (`case-law-ranking-signals.ts`): the row the per-candidate PostgreSQL read
 * returns, without its wide columns.
 *
 * The copy the signals are read off is the one PostgreSQL records as applied
 * (a `ServableCaseLawCopy` from the keyed read), never the copy the scan
 * happened to reach first: until its deletes settle, the index keeps stale,
 * withdrawn and never-applied copies beside the applied one, and a ranking
 * read off one of them would rank, or surface, what readers are not served.
 * The page a request returns is still read from PostgreSQL, which re-proves
 * for those rows alone everything that can change between the two reads.
 */
import type { SafeId } from "@/api/lib/branded-types";
import {
  CASE_LAW_RANKING_SIGNAL_FIELDS,
  CASE_LAW_RANKING_STORED_BASE_FIELDS,
  CITATION_AUTHORITY_BUCKET_MAX,
  citationAuthorityOfBucket,
  UNCITED_AUTHORITY_BUCKET,
} from "@/api/lib/legal-search/case-law-ranking-signals";
import type { CorpusIndexHit } from "@/api/lib/legal-search/corpus-index-client";
import type { CorpusProjectionRevision } from "@/api/lib/legal-search/corpus-index-revision-clause";

/** The stored fields a ranking read asks the scored transport for. */
export const CASE_LAW_RANKING_SCAN_FIELDS: readonly string[] = [
  ...CASE_LAW_RANKING_STORED_BASE_FIELDS,
  ...Object.values(CASE_LAW_RANKING_SIGNAL_FIELDS),
];

/**
 * A decision PostgreSQL may serve to this search, and the copy it serves:
 * published, from a redistributable source, inside the request's filters, and
 * holding an applied copy in the generation that serves its country with no
 * erasure queued.
 */
export type ServableCaseLawCopy = {
  id: SafeId<"caseLawDecision">;
  appliedRevision: CorpusProjectionRevision;
  appliedGeneration: string;
};

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
 * The candidate row a servable copy stands for, read off the stored fields of
 * that copy's best scanned passage, or null when the passage does not carry a
 * well-formed signal set: such a hit is excluded, as a row the database read
 * did not return is, rather than ranked on a guess.
 *
 * Can recur exactly when the database read says it can: a decision of more
 * than one passage, or one whose language group another published decision
 * shares.
 */
export const indexedCaseLawCandidateRow = (
  copy: ServableCaseLawCopy,
  fields: CorpusIndexHit,
): IndexedCaseLawCandidateRow | null => {
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
    id: copy.id,
    citationAuthority: citationAuthorityOfBucket(bucket),
    court,
    country,
    courtId,
    languageGroupKey,
    appliedRevision: copy.appliedRevision,
    appliedGeneration: copy.appliedGeneration,
    canRecur: passageCount !== 1 || shared,
  };
};
