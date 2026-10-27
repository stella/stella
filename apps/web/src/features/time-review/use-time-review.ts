import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { TIME_ENTRIES_APPROVAL_BATCH_MAX } from "@stll/api-contract/limits";
import type { TimeApprovalRefusal } from "@stll/api-contract/time-entries";

import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  useApproveTimeEntries,
  useReturnTimeEntry,
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

/**
 * Approving and returning time, shared by the matter's approval view and the
 * approver's page: per-row pending state, per-row refusals, bounded approval
 * batches, and the selection for bulk approval.
 */
export const useTimeReview = () => {
  const itemErrors = useItemErrors();
  const pending = usePendingRows();
  const approve = useApproveTimeEntries();
  const returnEntry = useReturnTimeEntry();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());

  const uncheck = (ids: readonly string[]) =>
    setChecked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        next.delete(id);
      }
      return next;
    });

  const requestApproval = async (targets: readonly ReviewTarget[]) => {
    const ids = targets.map(({ id }) => id);
    const outcome = await approve
      .mutateAsync({ workspaceIds: matterIdsOf(targets), ids })
      .then(
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
            ? [[result.id, itemErrors.refusalText(result.reason)]]
            : [],
        ),
      ),
    );
    uncheck(ids);
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
    // The API takes a bounded batch; a larger selection goes out in batches,
    // each settling its own entries.
    approve: (targets: readonly ReviewTarget[]) => {
      for (
        let start = 0;
        start < targets.length;
        start += TIME_ENTRIES_APPROVAL_BATCH_MAX
      ) {
        const batch = targets.slice(
          start,
          start + TIME_ENTRIES_APPROVAL_BATCH_MAX,
        );
        detached(
          pending.track(
            batch.map(({ id }) => id),
            requestApproval(batch),
          ),
          "time-review.approve",
        );
      }
    },
    returnToDraft: ({ id, workspaceId }: ReviewTarget, comment: string) => {
      const request = async () => {
        const returned = await Result.tryPromise({
          try: async () =>
            await returnEntry.mutateAsync({
              workspaceId,
              id,
              comment: comment.trim(),
            }),
          catch: (cause: unknown): unknown => cause,
        });
        if (Result.isError(returned)) {
          itemErrors.show([id], { [id]: itemErrors.errorText(returned.error) });
          return;
        }
        itemErrors.show([id], {});
        uncheck([id]);
      };
      detached(pending.track([id], request()), "time-review.return");
    },
  };
};

export type TimeReview = ReturnType<typeof useTimeReview>;
