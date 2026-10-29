import { useState } from "react";

import { useTranslations } from "use-intl";

import { TIME_ENTRIES_APPROVAL_BATCH_MAX } from "@stll/api-contract/limits";
import type {
  TimeApprovalRefusal,
  TimeReturnRefusal,
} from "@stll/api-contract/time-entries";

import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  useApproveTimeEntries,
  useReturnTimeEntries,
} from "@/lib/workspaces/mutations/time-entries";

const REFUSAL_KEYS = {
  not_found: "billing.approval.refusals.notFound",
  not_approver: "billing.approval.refusals.notApprover",
  not_submitted: "billing.approval.refusals.notSubmitted",
  wrong_status: "billing.approval.refusals.wrongStatus",
  running_timer: "billing.approval.refusals.runningTimer",
  unpriced: "billing.approval.refusals.unpriced",
  time_period_locked: "billing.globalTimer.periodLocked",
  invalid_entry: "billing.approval.refusals.invalidEntry",
} as const satisfies Record<TimeApprovalRefusal, TranslationKey>;

// A return reports only these, in its own words.
const RETURN_REFUSAL_KEYS = {
  not_found: "billing.approval.returnRefusals.notFound",
  not_approver: "billing.approval.returnRefusals.notApprover",
  not_submitted: "billing.approval.returnRefusals.notSubmitted",
  wrong_status: "billing.approval.returnRefusals.wrongStatus",
  running_timer: "billing.approval.returnRefusals.runningTimer",
  time_period_locked: "billing.approval.returnRefusals.timePeriodLocked",
  invalid_entry: "billing.approval.returnRefusals.invalidEntry",
} as const satisfies Record<TimeReturnRefusal, TranslationKey>;

const isRefusal = (code: string | undefined): code is TimeApprovalRefusal =>
  code !== undefined && Object.hasOwn(REFUSAL_KEYS, code);

/** An entry under review: its id and the matter it belongs to, if any. */
export type ReviewTarget = { id: string; workspaceId: string | null };

/**
 * The rows with a request in flight. Each row action awaits its own request
 * and settles only its own rows, so concurrent actions never drop an outcome.
 */
export const usePendingRows = () => {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const track = async (ids: readonly string[], request: Promise<void>) => {
    setPending((current) => new Set([...current, ...ids]));
    const settle = () =>
      setPending((current) => {
        const next = new Set(current);
        for (const id of ids) {
          next.delete(id);
        }
        return next;
      });
    await request.finally(settle);
  };
  return { has: (id: string) => pending.has(id), track };
};

/** Per-item errors, shown next to the entry they are about. */
export const useItemErrors = () => {
  const t = useTranslations();
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const failed = t("billing.approval.failed");
  return {
    errors,
    refusalText: (reason: TimeApprovalRefusal) => t(REFUSAL_KEYS[reason]),
    returnRefusalText: (reason: TimeReturnRefusal) =>
      t(RETURN_REFUSAL_KEYS[reason]),
    errorText: (error: unknown) =>
      APIError.is(error) && isRefusal(error.code)
        ? t(REFUSAL_KEYS[error.code])
        : userErrorFromThrown(error, failed),
    /** Replaces the errors of `ids` with `next`, keeping everyone else's. */
    show: (ids: readonly string[], next: Readonly<Record<string, string>>) =>
      setErrors((current) => ({
        ...Object.fromEntries(
          Object.entries(current).filter(([id]) => !ids.includes(id)),
        ),
        ...next,
      })),
  };
};

const matterIdsOf = (targets: readonly ReviewTarget[]) =>
  targets.flatMap(({ workspaceId }) =>
    workspaceId === null ? [] : [workspaceId],
  );

/** A review call's answer: one outcome per entry, refused ones with why. */
type ReviewBatch<TRefusal extends string> = {
  results: readonly (
    | { id: string; status: "refused"; reason: TRefusal }
    | { id: string; status: "approved" | "returned" }
  )[];
};

/**
 * Approving and returning time, shared by the matter's approval view and the
 * approver's page: per-row pending state, per-row refusals, bounded batches
 * for both decisions, and the selection they act on.
 */
export const useTimeReview = () => {
  const itemErrors = useItemErrors();
  const pending = usePendingRows();
  const approve = useApproveTimeEntries();
  const returnEntries = useReturnTimeEntries();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());

  const uncheck = (ids: readonly string[]) =>
    setChecked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        next.delete(id);
      }
      return next;
    });

  /** Shows each entry's refusal, or the failure on all of them. */
  const settle = async <TRefusal extends string>(
    ids: readonly string[],
    request: Promise<ReviewBatch<TRefusal>>,
    refusalText: (reason: TRefusal) => string,
  ) => {
    const outcome = await request.then(
      (batch) => ({ type: "answered" as const, batch }),
      (error: unknown) => ({ type: "failed" as const, error }),
    );
    if (outcome.type === "failed") {
      itemErrors.show(
        ids,
        Object.fromEntries(
          ids.map((id) => [id, itemErrors.errorText(outcome.error)]),
        ),
      );
      return;
    }
    itemErrors.show(
      ids,
      Object.fromEntries(
        outcome.batch.results.flatMap((result) =>
          result.status === "refused"
            ? [[result.id, refusalText(result.reason)]]
            : [],
        ),
      ),
    );
    uncheck(ids);
  };

  // The API takes a bounded batch; a larger selection goes out in batches,
  // each settling its own entries. One request per batch.
  const inBatches = <TRefusal extends string>(
    targets: readonly ReviewTarget[],
    send: (batch: readonly ReviewTarget[]) => Promise<ReviewBatch<TRefusal>>,
    refusalText: (reason: TRefusal) => string,
  ) => {
    const requests: Promise<void>[] = [];
    for (
      let start = 0;
      start < targets.length;
      start += TIME_ENTRIES_APPROVAL_BATCH_MAX
    ) {
      const batch = targets.slice(
        start,
        start + TIME_ENTRIES_APPROVAL_BATCH_MAX,
      );
      const ids = batch.map(({ id }) => id);
      requests.push(pending.track(ids, settle(ids, send(batch), refusalText)));
    }
    return requests;
  };

  return {
    errors: itemErrors.errors,
    isPending: pending.has,
    isChecked: (id: string) => checked.has(id),
    setChecked: (id: string, value: boolean) =>
      setChecked((current) => {
        const next = new Set(current);
        if (value) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      }),
    /** The checked entries still on screen, in the order given. */
    selectedOf: <T extends ReviewTarget>(rows: readonly T[]) =>
      rows.filter(({ id }) => checked.has(id)),
    approve: (targets: readonly ReviewTarget[]) => {
      const requests = inBatches(
        targets,
        async (batch) =>
          await approve.mutateAsync({
            workspaceIds: matterIdsOf(batch),
            ids: batch.map(({ id }) => id),
          }),
        itemErrors.refusalText,
      );
      for (const request of requests) {
        detached(request, "time-review.approve");
      }
    },
    /** Returns the entries to their owners with one reason. */
    returnToDraft: (targets: readonly ReviewTarget[], comment: string) => {
      const requests = inBatches(
        targets,
        async (batch) =>
          await returnEntries.mutateAsync({
            workspaceIds: matterIdsOf(batch),
            ids: batch.map(({ id }) => id),
            comment: comment.trim(),
          }),
        itemErrors.returnRefusalText,
      );
      for (const request of requests) {
        detached(request, "time-review.return");
      }
    },
  };
};

export type TimeReview = ReturnType<typeof useTimeReview>;
