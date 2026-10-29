import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { DECISION_TEXT_AVAILABILITY } from "@stll/api-contract/case-law-text-field";
import {
  CASE_LAW_TEXT_STATUS,
  type CaseLawTextStatus,
} from "@stll/api-contract/case-law-text-status";
import { missingBodyRetryable } from "@stll/decision-reader/decision-body-state.logic";
import type { MissingBodyReason } from "@stll/decision-reader/decision-body-state.logic";
import { Button } from "@stll/ui/button";

import { DecisionTextAvailabilityMarker } from "@/features/case-law/components/decision-text-availability";
import { publicDecisionReadFilter } from "@/features/case-law/queries/decisions";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";

/**
 * What the reader is told in place of the text. Total over the reasons, so a
 * new one cannot reach the pane unlabelled. A decision whose record carries
 * no document and one whose publisher offers none read the same to a lawyer;
 * they stay separate reasons because the read reports them separately.
 */
const MISSING_BODY_MESSAGE = {
  absent: "caseLaw.viewer.textUnavailable",
  pending: "caseLaw.viewer.textPending",
  readFailed: "caseLaw.viewer.textReadFailed",
  unavailable: "caseLaw.viewer.textUnavailable",
} as const satisfies Record<MissingBodyReason, TranslationKey>;

/**
 * The decision's text did not resolve, and the pane says which of the reasons
 * it was rather than standing empty. A reason the reader can do something
 * about carries the retry; one that will never change does not.
 */
export const MissingDecisionBody = ({
  busy = false,
  onRetry,
  reason,
  textState,
}: {
  busy?: boolean | undefined;
  onRetry: () => void;
  reason: MissingBodyReason;
  textState: CaseLawTextStatus | null;
}) => {
  const t = useTranslations();
  const retryable =
    missingBodyRetryable(reason) ||
    textState === CASE_LAW_TEXT_STATUS.FETCH_PENDING ||
    textState === CASE_LAW_TEXT_STATUS.FETCH_FAILED;

  return (
    <div className="reader-chrome flex flex-col items-center gap-3 py-16">
      <DecisionTextAvailabilityMarker
        textState={textState}
        availability={
          missingBodyRetryable(reason)
            ? DECISION_TEXT_AVAILABILITY.AVAILABLE
            : DECISION_TEXT_AVAILABILITY.METADATA_ONLY
        }
      />
      <p className="text-muted-foreground text-sm text-balance">
        {t(MISSING_BODY_MESSAGE[reason])}
      </p>
      {retryable && (
        <Button loading={busy} onClick={onRetry} size="sm" variant="outline">
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
};

/**
 * The same pane, wired to the reads behind it.
 *
 * The retry refetches every cached read holding this decision rather than one
 * chosen key: the page reaches a decision by slug and the inspector by id, so
 * a retry that asked only for the id would leave the read the page is showing
 * untouched. The reason stays the one derived from the copy on screen — a
 * fresher read reporting a body does not mean the body beside this pane
 * arrived, and reporting that a decision simply has no text would be a
 * terminal answer this pane has no grounds to give.
 */
export const DecisionBodyUnavailable = ({
  decisionId,
  reason,
  textState,
}: {
  decisionId: string;
  reason: MissingBodyReason;
  textState: CaseLawTextStatus | null;
}) => {
  const queryClient = useQueryClient();
  const filter = publicDecisionReadFilter(decisionId);

  return (
    <MissingDecisionBody
      busy={useIsFetching(filter) > 0}
      onRetry={() => {
        detached(
          queryClient.refetchQueries(filter),
          "case-law.decision-text-retry",
        );
      }}
      reason={reason}
      textState={textState}
    />
  );
};
