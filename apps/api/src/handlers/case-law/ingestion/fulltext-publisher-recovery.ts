import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  DECISION_TEXT_FAILURE,
  DECISION_TEXT_RECOVERY,
  type DecisionTextFailure,
  type DecisionTextRecovery,
  type DecisionTextState,
  publisherTextAbsenceEvidenceSchema,
} from "@stll/api-contract/case-law-fulltext-state";
import { CASE_LAW_TEXT_STATUS } from "@stll/api-contract/case-law-text-status";
import { parsePlainDate } from "@stll/time";

import { plUodoIsCourtReference } from "@/api/handlers/case-law/ingestion/adapters/pl-uodo.text-policy";
import {
  PL_UOKIK_DOCUMENT_ABSENCE,
  PL_UOKIK_DOCUMENT_ABSENCE_KEY,
} from "@/api/handlers/case-law/ingestion/adapters/pl-uokik.text-policy";
import { publisherTarget } from "@/api/handlers/case-law/ingestion/adapters/publisher-target";
import {
  FULLTEXT_RECOVERY_LIMITS,
  textFailureFromError,
} from "@/api/lib/case-law/fulltext-state";
import type { ClaimedDecisionTextWork } from "@/api/lib/case-law/fulltext-state-store";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";
import type {
  DecisionSupplement,
  IngestionResult,
  ListingIdentity,
  SourceAdapter,
} from "@/api/lib/legal-search/ingestion-types";

export type PublisherTextRecoveryOutcome =
  | {
      type: "built";
      decision: IngestionResult;
      companions?: readonly IngestionResult[] | undefined;
    }
  | { type: "built-supplement"; supplement: DecisionSupplement }
  | { type: "continued"; recovery: DecisionTextRecovery }
  | { type: "superseded" }
  | { type: "failed"; cause: DecisionTextFailure };

const refused = (code: string): PublisherTextRecoveryOutcome => ({
  type: "failed",
  cause: { kind: DECISION_TEXT_FAILURE.PARSER_REFUSAL, code },
});

const identityMatches = (
  identity: ListingIdentity,
  row: ClaimedDecisionTextWork,
): boolean => {
  switch (identity.type) {
    case "document":
      return (
        row.sourceDocumentId !== null &&
        identity.sourceDocumentId === row.sourceDocumentId
      );
    case "case-number":
      return (
        row.sourceDocumentId === null &&
        identity.caseNumber === row.caseNumber &&
        identity.language === row.language
      );
    case "unidentifiable":
      return false;
    default:
      identity satisfies never;
      return panic("Unhandled publisher listing identity");
  }
};

const corroboratesHeldDocument = (
  row: ClaimedDecisionTextWork,
  candidate: IngestionResult,
): boolean => {
  if (row.ecli && candidate.ecli !== row.ecli) {
    return false;
  }
  if (row.sheetNumber && candidate.sheetNumber !== row.sheetNumber) {
    return false;
  }
  if (row.sourceDocumentId !== null) {
    return candidate.sourceDocumentId === row.sourceDocumentId;
  }
  if (row.ecli || row.sheetNumber) {
    return true;
  }
  // A legacy docket without another identifier needs the same document locator.
  // A record/listing URL alone cannot distinguish the sheets of a court file.
  return Boolean(row.documentUrl && candidate.documentUrl === row.documentUrl);
};

export type CheckpointOutcome = "applied" | "superseded";

type PublisherTextRecoveryOptions = {
  adapter: SourceAdapter;
  row: ClaimedDecisionTextWork;
  recovery: DecisionTextRecovery;
  signal: AbortSignal;
  checkpoint: (recovery: DecisionTextRecovery) => Promise<CheckpointOutcome>;
};

/** Listing and build calls retain their adapter-owned robots, request and document gates. */
export const recoverFromPublisherListing = async ({
  adapter,
  row,
  recovery,
  signal,
  checkpoint,
}: PublisherTextRecoveryOptions): Promise<PublisherTextRecoveryOutcome> => {
  if (
    adapter.key === ADAPTER_KEYS.PL_UOKIK &&
    row.metadata?.[PL_UOKIK_DOCUMENT_ABSENCE_KEY] ===
      PL_UOKIK_DOCUMENT_ABSENCE.SCANNED
  ) {
    return refused("ocr_required");
  }
  const reconciliation = adapter.reconciliation;
  if (
    (row.sourceDocumentId !== null && !row.sourceDocumentId.trim()) ||
    (row.sourceDocumentId === null &&
      (!row.caseNumber.trim() || !row.language.trim()))
  ) {
    return refused("listing_identity_missing");
  }
  const date = row.decisionDate;
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    return refused("listing_date_missing");
  }
  const instant = new Date(`${date}T00:00:00.000Z`);
  if (parsePlainDate(date) === null) {
    return refused("listing_date_invalid");
  }
  // A held row can predate the crawl floor; its date, not firstSlice, owns its locator.
  const slice =
    recovery.type === DECISION_TEXT_RECOVERY.PUBLISHER_LISTING
      ? recovery.slice
      : reconciliation.sliceOf(instant);
  let page =
    recovery.type === DECISION_TEXT_RECOVERY.PUBLISHER_LISTING
      ? recovery.page
      : 0;
  for (
    let visited = 0;
    visited < FULLTEXT_RECOVERY_LIMITS.LISTING_PAGES;
    visited++
  ) {
    const pageToRead = page;
    const listed = await Result.tryPromise({
      try: async () => {
        signal.throwIfAborted();
        return await reconciliation.listSlicePage({
          slice,
          page: pageToRead,
          signal,
        });
      },
      catch: (error) =>
        textFailureFromError({
          error,
          phase: "publisher",
          timeoutMs: FULLTEXT_RECOVERY_LIMITS.ATTEMPT_TIMEOUT_MS,
        }),
    });
    if (Result.isError(listed)) {
      return { type: "failed", cause: listed.error };
    }
    const matches = listed.value.items.filter(({ identity }) =>
      identityMatches(identity, row),
    );
    if (matches.length > 1) {
      return refused("listing_identity_ambiguous");
    }
    const match = matches.at(0);
    if (match !== undefined) {
      // Keep the matched item retryable until its normal ingestion pipeline settles.
      const matchedCheckpoint = await Result.tryPromise({
        try: async () =>
          await checkpoint({
            type: DECISION_TEXT_RECOVERY.PUBLISHER_LISTING,
            slice,
            page: pageToRead,
          }),
        catch: (error) =>
          textFailureFromError({
            error,
            phase: "storage",
            timeoutMs: FULLTEXT_RECOVERY_LIMITS.ATTEMPT_TIMEOUT_MS,
          }),
      });
      if (Result.isError(matchedCheckpoint)) {
        return { type: "failed", cause: matchedCheckpoint.error };
      }
      if (matchedCheckpoint.value === "superseded") {
        return { type: "superseded" };
      }
      const built = await Result.tryPromise({
        try: async () => {
          signal.throwIfAborted();
          const build =
            reconciliation.createSliceBuildDecision?.() ??
            reconciliation.buildDecision.bind(reconciliation);
          return await build(match.payload, signal);
        },
        catch: (error) =>
          textFailureFromError({
            error,
            phase: "parser",
            timeoutMs: FULLTEXT_RECOVERY_LIMITS.ATTEMPT_TIMEOUT_MS,
          }),
      });
      if (Result.isError(built)) {
        return { type: "failed", cause: built.error };
      }
      switch (built.value.type) {
        case "built": {
          if (!corroboratesHeldDocument(row, built.value.decision)) {
            return refused("ambiguous_legacy_identity");
          }
          // The pipeline archives every fetched response before classifying its text outcome.
          return built.value;
        }
        case "built-supplement":
          if (!corroboratesHeldDocument(row, built.value.supplement.document)) {
            return refused("ambiguous_legacy_identity");
          }
          return built.value;
        case "detail-unavailable":
          return refused("listing_detail_unavailable");
        case "unkeyable":
          return refused("listing_detail_unkeyable");
        default:
          built.value satisfies never;
          return panic("Unhandled publisher listing build outcome");
      }
    }
    page++;
    const next = {
      type: DECISION_TEXT_RECOVERY.PUBLISHER_LISTING,
      slice,
      page,
    } as const;
    const saved = await Result.tryPromise({
      try: async () => await checkpoint(next),
      catch: (error) =>
        textFailureFromError({
          error,
          phase: "storage",
          timeoutMs: FULLTEXT_RECOVERY_LIMITS.ATTEMPT_TIMEOUT_MS,
        }),
    });
    if (Result.isError(saved)) {
      return { type: "failed", cause: saved.error };
    }
    if (saved.value === "superseded") {
      return { type: "superseded" };
    }
    if (page >= listed.value.totalPages) {
      return refused("listing_identity_not_found");
    }
  }
  return {
    type: "continued",
    recovery: { type: DECISION_TEXT_RECOVERY.PUBLISHER_LISTING, slice, page },
  };
};

type TerminalPublisherTextStateOptions = {
  adapterKey: AdapterKey;
  row: ClaimedDecisionTextWork;
  now: Date;
};

/** Only explicit source declarations can establish permanent text absence. */
export const terminalPublisherTextState = ({
  adapterKey,
  row,
  now,
}: TerminalPublisherTextStateOptions): DecisionTextState | null => {
  if (
    adapterKey === ADAPTER_KEYS.PL_UODO &&
    row.sourceDocumentId !== null &&
    plUodoIsCourtReference(row.sourceDocumentId)
  ) {
    return {
      status: CASE_LAW_TEXT_STATUS.METADATA_ONLY_BY_SOURCE,
      observedAt: now.toISOString(),
      policy: "pl_uodo_court_reference",
    };
  }
  if (
    adapterKey !== ADAPTER_KEYS.PL_UOKIK ||
    row.metadata?.[PL_UOKIK_DOCUMENT_ABSENCE_KEY] !==
      PL_UOKIK_DOCUMENT_ABSENCE.NO_ATTACHMENT
  ) {
    return null;
  }
  const evidence = v.safeParse(publisherTextAbsenceEvidenceSchema, {
    recordUrl: row.sourceUrl,
    sourceHash: row.sourceHash,
    field: PL_UOKIK_DOCUMENT_ABSENCE_KEY,
    kind: "no_document_attachment",
  });
  if (!evidence.success) {
    return null;
  }
  if (
    Result.isError(
      publisherTarget(ADAPTER_KEYS.PL_UOKIK, evidence.output.recordUrl),
    )
  ) {
    return null;
  }
  return {
    status: CASE_LAW_TEXT_STATUS.PUBLISHER_HAS_NO_TEXT,
    observedAt: now.toISOString(),
    evidence: evidence.output,
  };
};
