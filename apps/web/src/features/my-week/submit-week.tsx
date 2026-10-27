import { Result } from "better-result";
import { useTranslations } from "use-intl";

import type { TimeSubmitRefusal } from "@stll/api-contract/time-entries";
import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import type { Week } from "@/features/my-week/my-week.logic";
import type { SubmitWeekRequest } from "@/features/my-week/use-my-week-actions";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
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

const submitRange = async (
  submit: SubmitWeekActionsProps["submit"],
  request: SubmitWeekRequest,
) =>
  await Result.tryPromise({
    try: async () => await submit(request),
    catch: (cause: unknown): unknown => cause,
  });

const isTooManyEntries = (error: unknown) =>
  error instanceof APIError && error.code === "too_many_entries";

/**
 * The whole week in one request, or, when it holds more drafts than one batch
 * moves, one day at a time, so a busy week can still be submitted.
 */
const submitWeekInParts = async ({
  week,
  approve,
  submit,
}: {
  week: Week;
  approve: boolean;
  submit: SubmitWeekActionsProps["submit"];
}) => {
  const whole = await submitRange(submit, {
    startDate: week.start,
    endDate: week.end,
    approve,
  });
  if (!Result.isError(whole) || !isTooManyEntries(whole.error)) {
    return whole;
  }
  const results: SubmitOutcome["results"] = [];
  for (const date of week.days) {
    const day = await submitRange(submit, {
      startDate: date,
      endDate: date,
      approve,
    });
    if (Result.isError(day)) {
      return day;
    }
    results.push(...day.value.results);
  }
  return Result.ok({ results });
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
    const response = await submitWeekInParts({ week, approve, submit });
    if (Result.isError(response)) {
      notifyUserError(response.error, t("errors.actionFailed"));
      return;
    }
    const { results } = response.value;
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
