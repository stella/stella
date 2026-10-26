import { useTranslations } from "use-intl";

import type { TimeSubmitRefusal } from "@stll/api-contract/time-entries";
import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import type { Week } from "@/features/my-week/my-week.logic";
import type { SubmitWeekRequest } from "@/features/my-week/use-my-week-actions";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";

export const SUBMIT_REFUSAL_KEYS = {
  not_found: "billing.approval.refusals.notFound",
  wrong_status: "billing.approval.refusals.wrongStatus",
  running_timer: "timesheets.week.refusals.runningTimer",
  unpriced: "timesheets.week.refusals.unpriced",
  narrative_required: "timesheets.week.refusals.narrativeRequired",
  time_period_locked: "billing.globalTimer.periodLocked",
  invalid_entry: "timesheets.week.refusals.invalidEntry",
} as const satisfies Record<TimeSubmitRefusal, TranslationKey>;

type SubmitOutcome = {
  results: (
    | { id: string; status: "submitted" | "approved" }
    | { id: string; status: "refused"; reason: TimeSubmitRefusal }
  )[];
};

type SubmitWeekActionsProps = {
  week: Week;
  draftCount: number;
  /** Offer "Submit and approve" to someone who approves their own time. */
  canApproveOwn: boolean;
  submitting: boolean;
  submit: (request: SubmitWeekRequest) => Promise<SubmitOutcome>;
  onRefusals: (refusals: ReadonlyMap<string, TimeSubmitRefusal>) => void;
};

/**
 * Sends the week's drafts to their approvers in one step. Each draft moves or
 * is refused on its own; refusals are shown on their entries, and the rest
 * are confirmed in one line.
 */
export const SubmitWeekActions = ({
  week,
  draftCount,
  canApproveOwn,
  submitting,
  submit,
  onRefusals,
}: SubmitWeekActionsProps) => {
  const t = useTranslations();
  const run = async (approve: boolean) => {
    try {
      const { results } = await submit({
        startDate: week.start,
        endDate: week.end,
        approve,
      });
      const refusals = new Map<string, TimeSubmitRefusal>();
      let submitted = 0;
      let approved = 0;
      for (const result of results) {
        if (result.status === "refused") {
          refusals.set(result.id, result.reason);
        } else if (result.status === "approved") {
          approved += 1;
        } else {
          submitted += 1;
        }
      }
      onRefusals(refusals);
      stellaToast.add({
        title: t("timesheets.week.submitResult", {
          submitted,
          approved,
          refused: refusals.size,
        }),
        type: refusals.size > 0 ? "warning" : "success",
      });
    } catch (error) {
      notifyUserError(error, t("errors.actionFailed"));
    }
  };

  return (
    <>
      {canApproveOwn && (
        <Button
          disabled={draftCount === 0}
          loading={submitting}
          onClick={() => detached(run(true), "my-week.submit-and-approve")}
          size="sm"
          variant="outline"
        >
          {t("timesheets.week.submitAndApprove")}
        </Button>
      )}
      <Button
        disabled={draftCount === 0}
        loading={submitting}
        onClick={() => detached(run(false), "my-week.submit")}
        size="sm"
      >
        {t("timesheets.week.submitWeek")}
      </Button>
    </>
  );
};
