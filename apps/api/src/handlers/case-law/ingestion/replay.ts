import { panic, Result } from "better-result";
import { and, asc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
} from "@/api/db/schema";
import { STORED_RAW_REPARSE_REJECTION } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceAdapter,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
  StoredRawReparseRejection,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  allocateSourceObservationOrder,
  caseLawCanonicalPayload,
  DECISION_REFRESH,
  PROCESS_DECISION_STATUS,
  processDecision,
} from "@/api/handlers/case-law/ingestion/pipeline";
import { shouldSkipRefresh } from "@/api/handlers/case-law/ingestion/refresh-policy";
import {
  corpusCarriesDocument,
  payloadCarriesDocument,
} from "@/api/handlers/case-law/stored-payload";
import { withdrawCaseLawDecisionDocument } from "@/api/handlers/case-law/withdraw-document";
import type { WithdrawCaseLawDecisionDocumentOutcome } from "@/api/handlers/case-law/withdraw-document";
import type { SafeId } from "@/api/lib/branded-types";
import type { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { corpusContentHash } from "@/api/lib/legal-search/corpus-storage";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-storage";

/**
 * Re-parse decisions a source already ingested, from the raw payload stored
 * with them, without asking the publisher for anything.
 *
 * Two properties shape everything below.
 *
 * The re-parsed result goes through `processDecision`, the same function a
 * crawl feeds. Corpus-object storage, the content hash, the search
 * projection's staleness marker and citation extraction therefore behave
 * exactly as they do on a live crawl. Writing `fulltext`/`document_ast`
 * straight onto the row would bypass all of it and leave the projection
 * pointing at superseded content.
 *
 * The walk is a keyset over `(created_at, id)` whose boundary is resolved
 * in-database from the cursor row's id. `created_at` does not move when a
 * replay rewrites a row, so the traversal order is stable across runs, and
 * the boundary never round-trips through a millisecond-precision JS `Date`,
 * so it can neither re-serve nor skip the row it stopped on.
 *
 * What counts as a change is the payload the row would store, not the source
 * hash. The source hash covers the publisher's document, which by definition
 * did not move here: the whole point of a replay is that the bytes are the
 * ones already stored. A parser that restructures a document without
 * changing its words leaves that hash exactly where it was, so a replay
 * keyed on it would report every such migration as "unchanged" and apply
 * none of them. The comparison is therefore over the canonical payload the
 * row would store, plus the parser version and the source-side refresh
 * check; and where it says the row would change, the write is made under
 * `DECISION_REFRESH.ALWAYS`, since the pipeline's own dedup asks the
 * source-hash question this one deliberately does not.
 *
 * Together these make a re-run converge rather than accumulate: the second
 * pass derives the payload the row already holds, reports it unchanged, and
 * lets the pipeline advance the observation watermark alone. Where a write
 * does run, the corpus writer compares the derived keys against the ones
 * the row records and skips re-uploading a payload the row already holds.
 *
 * One outcome is outside that path. A row whose payload re-parses to no
 * document produces no result for the pipeline to write, so what is stored
 * stands however wrong a later parser says it was. Under
 * `REPLAY_REJECTION_POLICY.WITHDRAW_NO_DOCUMENT` such a row has its document
 * taken back instead — the row, its metadata and its stored payload are
 * kept, so a parser fix can still replay it into a document later.
 */

export const REPLAY_ROW_OUTCOME = {
  /** The pipeline applied the re-parsed result. */
  APPLIED: "applied",
  /** Re-parsing reproduced the stored result; nothing to write. */
  UNCHANGED: "unchanged",
  /** Dry run: the re-parse differs from what is stored. */
  WOULD_APPLY: "would-apply",
  /** The adapter could not rebuild a result from this payload. */
  REJECTED: "rejected",
  /** The row names a stored payload that object storage does not hold. */
  MISSING_PAYLOAD: "missing-payload",
  /** The pipeline reported a retryable failure; the walk holds here. */
  RETRYABLE: "retryable",
  /** The row held a document the re-parse says is not one; it is gone. */
  WITHDRAWN: "withdrawn",
  /** A corpus object outlived its delete, so the row kept its document. */
  WITHDRAW_INCOMPLETE: "withdraw-incomplete",
  /** Dry run: the row holds a document the re-parse says is not one. */
  WOULD_WITHDRAW: "would-withdraw",
} as const;

export type ReplayRowOutcome =
  (typeof REPLAY_ROW_OUTCOME)[keyof typeof REPLAY_ROW_OUTCOME];

/**
 * Columns a replay reads: everything the adapter needs to rebuild its
 * result, plus what decides whether replaying it would change the row.
 */
export type ReplayDecisionRow = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  sourceDocumentId: string | null;
  language: string;
  court: string;
  ecli: string | null;
  decisionDate: string | null;
  decisionType: string | null;
  sourceUrl: string | null;
  documentUrl: string | null;
  metadata: Record<string, unknown> | null;
  sourceHash: string | null;
  /**
   * Hash of the stored canonical payload. Null while the payload lives only
   * in the row's own columns; see {@link storedPayloadMatches}.
   */
  contentHash: string | null;
  parserVersion: number | null;
  sourceRawS3Key: string;
  sourceRawContentType: string | null;
  corpusMirrorStatus: (typeof CASE_LAW_CORPUS_MIRROR_STATUS)[keyof typeof CASE_LAW_CORPUS_MIRROR_STATUS];
};

/**
 * What a run does with a row whose re-parse yields no document.
 *
 * Reporting is the default because a re-parse that finds nothing is
 * usually the adapter, not the row: a payload it cannot read today may
 * replay cleanly after the next parser fix. Withdrawing is the opposite
 * claim — the stored text was never a document — and is opted into per
 * run, since it is the one replay outcome that removes text.
 */
export const REPLAY_REJECTION_POLICY = {
  /** Count it, name it in the report, leave the row alone. */
  REPORT: "report",
  /** Take back the stored document of a row that re-parses to none. */
  WITHDRAW_NO_DOCUMENT: "withdraw-no-document",
} as const;

export type ReplayRejectionPolicy =
  (typeof REPLAY_REJECTION_POLICY)[keyof typeof REPLAY_REJECTION_POLICY];

/**
 * The withdrawal a run performs, as a seam.
 *
 * Structural rather than the imported function's own type, so a test can
 * stand in for it without reaching object storage, and so the module
 * depends on the shape it calls rather than on that function's options.
 */
type WithdrawDocument = (options: {
  decisionId: SafeId<"caseLawDecision">;
  reason: string;
  scopedDb: ScopedDb;
}) => Promise<Result<WithdrawCaseLawDecisionDocumentOutcome, DatabaseError>>;

export const CASE_LAW_REPLAY_SCOPE = {
  SOURCE: { type: "source" },
} as const;

/**
 * Exact subset of one source a replay walks. A discriminator makes adding a
 * future dependency scope an explicit query and cursor-boundary decision.
 */
export type CaseLawReplayScope =
  | (typeof CASE_LAW_REPLAY_SCOPE)[keyof typeof CASE_LAW_REPLAY_SCOPE]
  | { type: "court"; court: string }
  | { type: "celex"; celex: string };

const replayScopePredicate = (scope: CaseLawReplayScope): SQL | undefined => {
  switch (scope.type) {
    case "source":
      return undefined;
    case "court":
      return eq(caseLawDecisions.court, scope.court);
    case "celex":
      return sql`${caseLawDecisions.metadata}->>'celex' = ${scope.celex}`;
    default:
      scope satisfies never;
      return panic(`Unhandled scope: ${String(scope)}`);
  }
};

type SelectReplayPageOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  scope: CaseLawReplayScope;
  /** Boundary row id; the page returns rows strictly after it. */
  after: SafeId<"caseLawDecision"> | null;
  limit: number;
};

/**
 * One page of replayable decisions, oldest first.
 *
 * A redacted row is excluded: its payload was erased deliberately and a
 * replay must not put text back on it. A row without a stored key is
 * excluded because there is nothing local to replay from; those rows are
 * counted separately by {@link countReplayability}.
 */
export const selectReplayPage = async ({
  scopedDb,
  sourceId,
  scope,
  after,
  limit,
}: SelectReplayPageOptions): Promise<ReplayDecisionRow[]> => {
  const rows = await scopedDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        sourceDocumentId: caseLawDecisions.sourceDocumentId,
        language: caseLawDecisions.language,
        court: caseLawDecisions.court,
        ecli: caseLawDecisions.ecli,
        decisionDate: caseLawDecisions.decisionDate,
        decisionType: caseLawDecisions.decisionType,
        sourceUrl: caseLawDecisions.sourceUrl,
        documentUrl: caseLawDecisions.documentUrl,
        metadata: caseLawDecisions.metadata,
        sourceHash: caseLawDecisions.sourceHash,
        contentHash: caseLawDecisions.contentHash,
        parserVersion: caseLawDecisions.parserVersion,
        sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
        sourceRawContentType: caseLawDecisions.sourceRawContentType,
        corpusMirrorStatus: caseLawDecisions.corpusMirrorStatus,
      })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          replayScopePredicate(scope),
          isNotNull(caseLawDecisions.sourceRawS3Key),
          isNull(caseLawDecisions.redactedAt),
          // The boundary row's `(created_at, id)` is looked up by id inside
          // the database, so the comparison stays at the column's microsecond
          // precision. A boundary carried out as a JS `Date` would be
          // truncated to milliseconds, and an ascending keyset over a
          // truncated boundary re-serves the row it stopped on forever.
          after === null
            ? undefined
            : sql`(${caseLawDecisions.createdAt}, ${caseLawDecisions.id}) > (select b.created_at, b.id from case_law_decisions b where b.id = ${after})`,
        ),
      )
      .orderBy(asc(caseLawDecisions.createdAt), asc(caseLawDecisions.id))
      .limit(limit),
  );

  return rows.filter(
    (row): row is ReplayDecisionRow => row.sourceRawS3Key !== null,
  );
};

export type ReplayabilitySplit = {
  /** Rows whose stored payload can be re-parsed locally. */
  storedLocally: number;
  /** Rows with no stored payload; only a re-fetch can re-parse them. */
  needsRefetch: number;
};

type CountReplayabilityOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  scope: CaseLawReplayScope;
};

/**
 * How much of a scope can be replayed without the publisher. Redacted rows
 * are in neither count: they are not re-parsed by any path.
 */
export const countReplayability = async ({
  scopedDb,
  sourceId,
  scope,
}: CountReplayabilityOptions): Promise<ReplayabilitySplit> => {
  const [counts] = await scopedDb((tx) =>
    tx
      .select({
        storedLocally: sql<string>`count(*) filter (where ${caseLawDecisions.sourceRawS3Key} is not null)`,
        needsRefetch: sql<string>`count(*) filter (where ${caseLawDecisions.sourceRawS3Key} is null)`,
      })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          replayScopePredicate(scope),
          isNull(caseLawDecisions.redactedAt),
        ),
      ),
  );

  return {
    storedLocally: Number(counts?.storedLocally ?? 0),
    needsRefetch: Number(counts?.needsRefetch ?? 0),
  };
};

export type ReplayCapability =
  | {
      type: "supported";
      reparse: NonNullable<SourceAdapter["reparseStoredRaw"]>;
    }
  | { type: "unsupported"; adapterKey: string };

/**
 * Whether this adapter can map one stored payload back to one decision.
 *
 * An adapter that cannot is reported, never treated as a run with nothing to
 * do: the two look identical in a summary line, and only one of them means
 * the operator has to re-fetch from the publisher instead.
 */
export const replayCapability = (adapter: SourceAdapter): ReplayCapability =>
  adapter.reparseStoredRaw === undefined
    ? { type: "unsupported", adapterKey: adapter.key }
    : { type: "supported", reparse: adapter.reparseStoredRaw };

/** Reads a stored payload by key; null when object storage does not hold it. */
export type StoredRawReader = (key: string) => Promise<Uint8Array | null>;

export type ReplayRowReport = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  language: string;
  outcome: ReplayRowOutcome;
  /** Present on `rejected`, `retryable` and `missing-payload`. */
  detail?: string | undefined;
  rejection?: StoredRawReparseRejection | undefined;
};

export type ReplayRunReport = {
  visited: number;
  outcomes: Record<ReplayRowOutcome, number>;
  rejections: Record<StoredRawReparseRejection, number>;
  /** Every row that produced no result, so advancing is always auditable. */
  problems: ReplayRowReport[];
  /**
   * Id of the last row this run finished, or null when it finished none.
   * Passing it back as `after` resumes exactly where the run stopped, and
   * the boundary comparison is exact, so the row is neither repeated nor
   * skipped.
   */
  resumeAfter: SafeId<"caseLawDecision"> | null;
  /** Why the run stopped before its limit, if it did. */
  haltReason: string | null;
};

// Both counters are annotated with a total `Record` over their union, so a
// new outcome or rejection reason fails to compile until it is counted here.
const emptyOutcomeCounts = (): Record<ReplayRowOutcome, number> => ({
  [REPLAY_ROW_OUTCOME.APPLIED]: 0,
  [REPLAY_ROW_OUTCOME.UNCHANGED]: 0,
  [REPLAY_ROW_OUTCOME.WOULD_APPLY]: 0,
  [REPLAY_ROW_OUTCOME.REJECTED]: 0,
  [REPLAY_ROW_OUTCOME.MISSING_PAYLOAD]: 0,
  [REPLAY_ROW_OUTCOME.RETRYABLE]: 0,
  [REPLAY_ROW_OUTCOME.WITHDRAWN]: 0,
  [REPLAY_ROW_OUTCOME.WITHDRAW_INCOMPLETE]: 0,
  [REPLAY_ROW_OUTCOME.WOULD_WITHDRAW]: 0,
});

const emptyRejectionCounts = (): Record<StoredRawReparseRejection, number> => ({
  [STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA]: 0,
  [STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH]: 0,
  [STORED_RAW_REPARSE_REJECTION.RAW_FIDELITY_LOST]: 0,
  [STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT]: 0,
  [STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT]: 0,
});

const REPLAY_OUTCOME_DISPOSITION = {
  [REPLAY_ROW_OUTCOME.APPLIED]: "ok",
  [REPLAY_ROW_OUTCOME.UNCHANGED]: "ok",
  [REPLAY_ROW_OUTCOME.WOULD_APPLY]: "ok",
  [REPLAY_ROW_OUTCOME.REJECTED]: "problem",
  [REPLAY_ROW_OUTCOME.MISSING_PAYLOAD]: "problem",
  [REPLAY_ROW_OUTCOME.RETRYABLE]: "problem",
  // A withdrawal is intended, and still a row that lost its text: it is
  // listed so the operator sees which decisions the run emptied.
  [REPLAY_ROW_OUTCOME.WITHDRAWN]: "problem",
  [REPLAY_ROW_OUTCOME.WITHDRAW_INCOMPLETE]: "problem",
  [REPLAY_ROW_OUTCOME.WOULD_WITHDRAW]: "problem",
} as const satisfies Record<ReplayRowOutcome, "ok" | "problem">;

const storedInputFor = (
  row: ReplayDecisionRow,
  raw: Uint8Array,
): StoredRawReparseInput => ({
  raw,
  contentType: row.sourceRawContentType,
  caseNumber: row.caseNumber,
  sourceDocumentId: row.sourceDocumentId,
  language: row.language,
  court: row.court,
  ecli: row.ecli,
  decisionDate: row.decisionDate,
  decisionType: row.decisionType,
  sourceUrl: row.sourceUrl,
  documentUrl: row.documentUrl,
  metadata: row.metadata ?? {},
});

type ReplayRowOptions = {
  row: ReplayDecisionRow;
  /** The payload this replay read, as stored. */
  raw: Uint8Array;
  reparsed: StoredRawReparseOutcome;
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  /** Present only when the run writes; a dry run holds no lease. */
  sourceLease: CaseLawSourceIngestionLease | null;
  rejectionPolicy: ReplayRejectionPolicy;
  /** Test seam, threaded to the withdrawal's corpus-object delete. */
  withdraw: WithdrawDocument;
};

/**
 * Whether the row still holds a document to withdraw.
 *
 * Asked the same two ways `storedPayloadMatches` asks its question, and
 * for the same reason: the payload lives either in object storage, where
 * the content hash names it, or in the row's own columns.
 */
const rowHoldsDocument = async ({
  row,
  scopedDb,
}: {
  row: ReplayDecisionRow;
  scopedDb: ScopedDb;
}): Promise<boolean> => {
  if (row.contentHash !== null) {
    return corpusCarriesDocument(row.contentHash);
  }
  const stored = await scopedDb((tx) =>
    tx
      .select({
        documentAst: caseLawDecisions.documentAst,
        fulltext: caseLawDecisions.fulltext,
        sections: caseLawDecisions.sections,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, row.id))
      .limit(1),
  );
  const columns = stored.at(0);
  return payloadCarriesDocument({
    ast: columns?.documentAst ?? null,
    sections: columns?.sections ?? null,
    text: columns?.fulltext ?? null,
  });
};

/**
 * Take back the document of a row whose payload re-parses to none.
 *
 * A rejection is reported and nothing else, unless this run opted into
 * withdrawing and the adapter's reason is that the payload holds no
 * document at all: every other rejection says the replay could not read
 * the row, which is not a statement about what the row holds. A row that
 * holds no document already is reported as the rejection it is, so a
 * second run over the same rows withdraws nothing.
 */
const withdrawRejectedRow = async ({
  row,
  rejection,
  detail,
  rejectionPolicy,
  scopedDb,
  sourceLease,
  withdraw,
}: {
  row: ReplayDecisionRow;
  rejection: StoredRawReparseRejection;
  detail: string;
  rejectionPolicy: ReplayRejectionPolicy;
  scopedDb: ScopedDb;
  sourceLease: CaseLawSourceIngestionLease | null;
  withdraw: WithdrawDocument;
}): Promise<ReplayRowReport> => {
  const rejected: ReplayRowReport = {
    id: row.id,
    caseNumber: row.caseNumber,
    language: row.language,
    outcome: REPLAY_ROW_OUTCOME.REJECTED,
    rejection,
    detail,
  };

  if (
    rejectionPolicy !== REPLAY_REJECTION_POLICY.WITHDRAW_NO_DOCUMENT ||
    rejection !== STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT ||
    !(await rowHoldsDocument({ row, scopedDb }))
  ) {
    return rejected;
  }

  if (sourceLease === null) {
    return { ...rejected, outcome: REPLAY_ROW_OUTCOME.WOULD_WITHDRAW };
  }

  await sourceLease.beforeDatabaseMark();
  const attempt = await withdraw({
    decisionId: row.id,
    reason: `re-parse yielded no document under parser version ${row.parserVersion ?? 0}: ${detail}`,
    scopedDb,
  });
  // A withdrawal that could not fence the row says nothing about the row.
  // Reported as retryable, which holds the walk where it is: skipping past
  // it would leave a forward-only traversal with no way back to it.
  if (Result.isError(attempt)) {
    return {
      ...rejected,
      outcome: REPLAY_ROW_OUTCOME.RETRYABLE,
      detail: `${detail}; withdrawal failed: ${attempt.error.message}`,
    };
  }

  const withdrawn = attempt.value;
  switch (withdrawn.type) {
    case "withdrawn":
      return { ...rejected, outcome: REPLAY_ROW_OUTCOME.WITHDRAWN };
    case "corpus-objects-remain":
      // Nothing was written: an object the delete did not confirm still
      // serves the payload, so the row keeps its document and a later run
      // retries the whole withdrawal. Reported rather than held, because
      // the walk only moves forward and one undeletable object must not
      // stop every row behind it from being visited.
      return {
        ...rejected,
        outcome: REPLAY_ROW_OUTCOME.WITHDRAW_INCOMPLETE,
        detail: `${detail}; a corpus object still holds the payload`,
      };
    case "not-found":
      return {
        ...rejected,
        detail: `${detail}; the row was gone before it could be withdrawn`,
      };
    default: {
      withdrawn satisfies never;
      return panic(`Unhandled withdrawal outcome: ${String(withdrawn)}`);
    }
  }
};

/**
 * Whether the row already holds this payload.
 *
 * Asked two ways, because the payload is stored two ways. Where the corpus
 * write recorded a content hash, that hash *is* the stored payload's
 * identity, and the incoming payload is hashed by the same function that
 * produced it. Where the payload lives in the row's own jsonb columns there
 * is no such hash, and one cannot be taken over them either: jsonb does not
 * preserve object key order, so re-serializing what comes back would differ
 * from the value that was written even when the document is identical.
 * Those are compared structurally, which key order does not affect.
 */
const storedPayloadMatches = async ({
  payload,
  row,
  scopedDb,
}: {
  payload: CorpusPayload;
  row: ReplayDecisionRow;
  scopedDb: ScopedDb;
}): Promise<boolean> => {
  if (row.contentHash !== null) {
    return row.contentHash === corpusContentHash(payload);
  }
  const stored = await scopedDb((tx) =>
    tx
      .select({
        documentAst: caseLawDecisions.documentAst,
        fulltext: caseLawDecisions.fulltext,
        sections: caseLawDecisions.sections,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, row.id))
      .limit(1),
  );
  const columns = stored.at(0);
  return Bun.deepEquals(
    {
      ast: columns?.documentAst ?? null,
      sections: columns?.sections ?? null,
      text: columns?.fulltext ?? null,
    },
    payload,
  );
};

/**
 * Whether replaying this result would change what the row holds.
 *
 * Three questions, because a parser change can move any of them
 * independently:
 *
 * - the source-side refresh check the pipeline itself applies, which covers
 *   the publisher's hash and the ingestion metadata (keywords included);
 * - the canonical payload's content hash, which is what a restructure moves
 *   while the flattened text stays identical — the case a source-hash
 *   comparison alone would report as unchanged and never apply;
 * - the parser version recorded on the row, so a version the row never
 *   caught up with is not left behind.
 */
const replayWouldChangeRow = async ({
  row,
  result,
  scopedDb,
}: {
  row: ReplayDecisionRow;
  result: IngestionResult;
  scopedDb: ScopedDb;
}): Promise<boolean> => {
  if (row.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.PENDING) {
    return true;
  }
  const sourceChanged = !shouldSkipRefresh({
    existingMetadata: row.metadata,
    existingSourceHash: row.sourceHash,
    incomingMetadata: result.metadata,
    incomingRawHash: result.rawHash,
  });
  if (sourceChanged) {
    return true;
  }
  if ((row.parserVersion ?? 0) !== (result.parserVersion ?? 0)) {
    return true;
  }
  return !(await storedPayloadMatches({
    payload: caseLawCanonicalPayload(result),
    row,
    scopedDb,
  }));
};

/**
 * Apply one re-parsed result, or say what applying it would do.
 *
 * A row the replay would not change is still handed to the pipeline, which
 * advances the observation watermark and writes nothing else. A row it would
 * change is written under `DECISION_REFRESH.ALWAYS`, because the pipeline's
 * own dedup asks only whether the publisher's document moved, and here it
 * did not: the payload the parser derives from it did.
 */
const replayRow = async ({
  row,
  raw,
  reparsed,
  rejectionPolicy,
  scopedDb,
  sourceId,
  sourceLease,
  withdraw,
}: ReplayRowOptions): Promise<ReplayRowReport> => {
  const base = {
    id: row.id,
    caseNumber: row.caseNumber,
    language: row.language,
  };

  if (reparsed.type === "rejected") {
    return await withdrawRejectedRow({
      row,
      rejection: reparsed.rejection,
      detail: reparsed.detail,
      rejectionPolicy,
      scopedDb,
      sourceLease,
      withdraw,
    });
  }

  const regeneratedIdentity = {
    caseNumber: reparsed.result.caseNumber,
    language: reparsed.result.language,
    sourceDocumentId: reparsed.result.sourceDocumentId ?? null,
  };
  const selectedIdentity = {
    caseNumber: row.caseNumber,
    language: row.language,
    sourceDocumentId: row.sourceDocumentId,
  };
  if (!Bun.deepEquals(regeneratedIdentity, selectedIdentity)) {
    return {
      ...base,
      outcome: REPLAY_ROW_OUTCOME.REJECTED,
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: `selected ${JSON.stringify(selectedIdentity)}, regenerated ${JSON.stringify(regeneratedIdentity)}`,
    };
  }

  const changed = await replayWouldChangeRow({
    row,
    result: reparsed.result,
    scopedDb,
  });

  if (sourceLease === null) {
    return {
      ...base,
      outcome: changed
        ? REPLAY_ROW_OUTCOME.WOULD_APPLY
        : REPLAY_ROW_OUTCOME.UNCHANGED,
    };
  }

  // Ordered on the source's own counter, under its lease: the row guards
  // compare observation orders, so a replay numbering itself independently
  // could overwrite a crawl observation newer than the payload it replayed.
  await sourceLease.beforeDatabaseMark();
  const observationOrder = await allocateSourceObservationOrder({
    leaseToken: sourceLease.leaseToken,
    scopedDb,
    sourceId,
  });

  const processed = await processDecision({
    // The payload travels with the result, always, whatever the adapter put
    // in it. The pipeline writes the row's raw-payload pointer from the
    // result it is handed, so a result that carried no payload would clear
    // the stored key and leave the row unreplayable — it would destroy the
    // one thing that makes this local. These are the bytes this run read,
    // and the pipeline keys the object on their own hash, so it recognises
    // the key the row already holds and skips the re-upload.
    input: {
      ...reparsed.result,
      sourceRawBytes: raw,
      sourceRawContentType:
        row.sourceRawContentType ?? reparsed.result.sourceRawContentType,
    },
    sourceId,
    scopedDb,
    // The replay observed the stored payload now. The pipeline records this
    // as the observation's time, which is what orders it against a crawl.
    observedAt: new Date(),
    observationOrder,
    refresh: changed
      ? DECISION_REFRESH.ALWAYS
      : DECISION_REFRESH.WHEN_SOURCE_CHANGED,
  });

  if (processed.status === PROCESS_DECISION_STATUS.RETRYABLE) {
    return {
      ...base,
      outcome: REPLAY_ROW_OUTCOME.RETRYABLE,
      detail: processed.reason,
    };
  }

  return {
    ...base,
    outcome: changed
      ? REPLAY_ROW_OUTCOME.APPLIED
      : REPLAY_ROW_OUTCOME.UNCHANGED,
  };
};

type ReplayOneRowOptions = {
  capability: Extract<ReplayCapability, { type: "supported" }>;
  readStoredRaw: StoredRawReader;
  row: ReplayDecisionRow;
  rejectionPolicy: ReplayRejectionPolicy;
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  sourceLease: CaseLawSourceIngestionLease | null;
  withdraw: WithdrawDocument;
};

/**
 * The whole per-row sequence: read the stored payload, re-parse it, replay
 * the result.
 *
 * Rejects only on a failure that says nothing about the row. A reader
 * returning `null` is the opposite: it means the store confirmed it holds no
 * such object, which is a durable fact about that decision and is reported
 * as one.
 */
const replayOneRow = async ({
  capability,
  readStoredRaw,
  row,
  rejectionPolicy,
  scopedDb,
  sourceId,
  sourceLease,
  withdraw,
}: ReplayOneRowOptions): Promise<ReplayRowReport> => {
  const raw = await readStoredRaw(row.sourceRawS3Key);
  if (raw === null) {
    return {
      id: row.id,
      caseNumber: row.caseNumber,
      language: row.language,
      outcome: REPLAY_ROW_OUTCOME.MISSING_PAYLOAD,
      detail: row.sourceRawS3Key,
    };
  }
  return await replayRow({
    row,
    raw,
    reparsed: await capability.reparse(storedInputFor(row, raw)),
    rejectionPolicy,
    scopedDb,
    sourceId,
    sourceLease,
    withdraw,
  });
};

/** Bounded, printable context for a failure that halted the run. */
const FAILURE_DETAIL_LIMIT = 300;

const failureDetail = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(
    0,
    FAILURE_DETAIL_LIMIT,
  );

/** Pause between lease attempts while a replay waits for the source. */
export const REPLAY_LEASE_RETRY_PAUSE_MS = 5000;

export type ReplayLeaseAcquisition<TLease> =
  | { type: "acquired"; lease: TLease; waitedMs: number }
  | { type: "unavailable"; waitedMs: number };

// Generic over the lease because the wait reads nothing from it: an acquire
// either produced one or did not.
export type AcquireReplayLeaseOptions<TLease> = {
  acquire: () => Promise<TLease | null>;
  /** Paused time the acquire may be retried for; 0 attempts once. */
  waitBudgetMs: number;
  /** Called once, when the first attempt lost and the wait begins. */
  onWaitStart?: () => void;
  /** Test seam; a run sleeps. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Take a source's ingestion lease, waiting out an ingestion that holds it.
 *
 * An ingestion takes the lease per reconciliation unit and releases it in
 * between, so a single attempt made while the source is being crawled loses
 * far more often than it wins. Retrying on a fixed pause claims one of the
 * gaps instead; the budget bounds the wait so an unattended run still ends.
 *
 * The budget counts paused time alone: an attempt is one indexed update, and
 * counting attempts too would make the number of tries depend on database
 * latency.
 */
export const acquireReplayLease = async <TLease>({
  acquire,
  waitBudgetMs,
  onWaitStart,
  sleep = Bun.sleep,
}: AcquireReplayLeaseOptions<TLease>): Promise<
  ReplayLeaseAcquisition<TLease>
> => {
  const lease = await acquire();
  if (lease !== null) {
    return { type: "acquired", lease, waitedMs: 0 };
  }
  if (waitBudgetMs < REPLAY_LEASE_RETRY_PAUSE_MS) {
    return { type: "unavailable", waitedMs: 0 };
  }

  onWaitStart?.();
  let waitedMs = 0;
  while (waitedMs + REPLAY_LEASE_RETRY_PAUSE_MS <= waitBudgetMs) {
    await sleep(REPLAY_LEASE_RETRY_PAUSE_MS);
    waitedMs += REPLAY_LEASE_RETRY_PAUSE_MS;
    const retried = await acquire();
    if (retried !== null) {
      return { type: "acquired", lease: retried, waitedMs };
    }
  }
  return { type: "unavailable", waitedMs };
};

export type ReplayCaseLawSourceOptions = {
  adapter: SourceAdapter;
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  readStoredRaw: StoredRawReader;
  /** Held for a writing run; null for a dry run, which writes nothing. */
  sourceLease: CaseLawSourceIngestionLease | null;
  /** Maximum decisions to visit in this run. */
  limit: number;
  pageSize: number;
  after?: SafeId<"caseLawDecision"> | null;
  scope: CaseLawReplayScope;
  /** Defaults to reporting; withdrawing is opted into per run. */
  rejectionPolicy?: ReplayRejectionPolicy;
  /** Test seam; production withdraws through the canonical stores. */
  withdraw?: WithdrawDocument;
};

export type ReplayRun =
  | { type: "unsupported"; adapterKey: string }
  | { type: "unknown-boundary"; after: SafeId<"caseLawDecision"> }
  | { type: "ran"; report: ReplayRunReport };

/**
 * A resume boundary must be a row of the exact scope being replayed.
 *
 * The keyset looks the boundary up by id alone, so an id belonging to
 * another source would position the walk by an unrelated timestamp and skip
 * whatever sorts before it, and an id that does not exist would make the
 * tuple comparison null and return nothing at all. Both read as "no work to
 * do", which is the one thing a resume must never say quietly.
 */
const boundaryBelongsToScope = async ({
  after,
  scopedDb,
  sourceId,
  scope,
}: {
  after: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  scope: CaseLawReplayScope;
}): Promise<boolean> => {
  const found = await scopedDb((tx) =>
    tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.id, after),
          eq(caseLawDecisions.sourceId, sourceId),
          replayScopePredicate(scope),
        ),
      )
      .limit(1),
  );
  return found.length > 0;
};

/**
 * Walk a source's replayable decisions, oldest first, one at a time.
 *
 * An adapter that cannot re-parse a stored payload returns `unsupported`
 * before anything is read, and a resume boundary that is not a row of this
 * source returns `unknown-boundary`: the walk is not entered, so neither can
 * be mistaken for a run that found nothing to do.
 *
 * Sequential by construction: each row's write must be ordered against the
 * source's observation counter, and a bounded operator run has no reason to
 * hold several corpus writes open at once.
 *
 * The run stops on the first retryable outcome and reports the last row it
 * finished. Skipping past a row the pipeline said to retry would leave the
 * walk with no way back to it, since the traversal only moves forward.
 */
export const replayCaseLawSource = async ({
  adapter,
  scopedDb,
  sourceId,
  readStoredRaw,
  sourceLease,
  limit,
  pageSize,
  after = null,
  scope,
  rejectionPolicy = REPLAY_REJECTION_POLICY.REPORT,
  withdraw = withdrawCaseLawDecisionDocument,
}: ReplayCaseLawSourceOptions): Promise<ReplayRun> => {
  const capability = replayCapability(adapter);
  if (capability.type === "unsupported") {
    return capability;
  }

  if (
    after !== null &&
    !(await boundaryBelongsToScope({
      after,
      scopedDb,
      sourceId,
      scope,
    }))
  ) {
    return { type: "unknown-boundary", after };
  }

  const outcomes = emptyOutcomeCounts();
  const rejections = emptyRejectionCounts();
  const problems: ReplayRowReport[] = [];
  let cursor = after;
  let resumeAfter: SafeId<"caseLawDecision"> | null = null;
  let visited = 0;
  let haltReason: string | null = null;

  const ran = (): ReplayRun => ({
    type: "ran",
    report: {
      visited,
      outcomes,
      rejections,
      problems,
      resumeAfter,
      haltReason,
    },
  });

  const replayPage = async (
    page: readonly ReplayDecisionRow[],
    index = 0,
  ): Promise<boolean> => {
    const row = page.at(index);
    if (row === undefined) {
      return true;
    }

    const attempt = await Result.tryPromise({
      try: async () =>
        await replayOneRow({
          capability,
          readStoredRaw,
          row,
          rejectionPolicy,
          scopedDb,
          sourceId,
          sourceLease,
          withdraw,
        }),
      catch: (cause) => cause,
    });

    // A failure that says nothing about the row (a payload read that did
    // not confirm absence, a database error) is not a fact to record
    // against it. The run stops with the cursor still behind the row, so
    // resuming re-attempts it instead of stepping over it forever.
    if (Result.isError(attempt)) {
      haltReason = `${row.caseNumber} (${row.language}) could not be replayed: ${failureDetail(attempt.error)}`;
      return false;
    }
    const rowReport = attempt.value;

    visited += 1;
    outcomes[rowReport.outcome] += 1;
    if (rowReport.rejection !== undefined) {
      rejections[rowReport.rejection] += 1;
    }
    if (REPLAY_OUTCOME_DISPOSITION[rowReport.outcome] === "problem") {
      problems.push(rowReport);
    }
    cursor = row.id;

    if (rowReport.outcome === REPLAY_ROW_OUTCOME.RETRYABLE) {
      haltReason = `retryable outcome on ${row.caseNumber} (${row.language}): ${rowReport.detail ?? ""}`;
      return false;
    }
    resumeAfter = row.id;
    return await replayPage(page, index + 1);
  };

  const walk = async (): Promise<void> => {
    if (visited >= limit) {
      return;
    }
    const page = await selectReplayPage({
      scopedDb,
      sourceId,
      scope,
      after: cursor,
      limit: Math.min(pageSize, limit - visited),
    });
    if (page.length === 0) {
      return;
    }
    if (await replayPage(page)) {
      await walk();
    }
  };

  await walk();

  return ran();
};
