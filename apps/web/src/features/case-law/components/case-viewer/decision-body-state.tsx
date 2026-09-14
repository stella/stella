import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { missingBodyRetryable } from "@/features/case-law/components/case-viewer/decision-body-state.logic";
import type { MissingBodyReason } from "@/features/case-law/components/case-viewer/decision-body-state.logic";
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
}: {
  busy?: boolean | undefined;
  onRetry: () => void;
  reason: MissingBodyReason;
}) => {
  const t = useTranslations();

  return (
    <div className="reader-chrome flex flex-col items-center gap-3 py-16">
      <p className="text-muted-foreground text-sm text-balance">
        {t(MISSING_BODY_MESSAGE[reason])}
      </p>
      {missingBodyRetryable(reason) && (
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
}: {
  decisionId: string;
  reason: MissingBodyReason;
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
    />
  );
};
