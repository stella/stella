import { useOptimistic, useState, useTransition } from "react";

import { Result } from "better-result";

import { useChanged } from "@/components/changes";
import type { ChangeKind } from "@/components/changes";
import { writeFailure } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";

/**
 * A value changed in one step from a row or a sheet, such as a task's
 * status. The change shows at once; once saved it stays until a load
 * reports something new, and the lists of `kind` load afresh. A change that
 * does not save goes back, with why, for `WriteFailureNotice`.
 */
export const useOptimisticWrite = <T extends boolean | string>({
  kind,
  reported,
  source,
}: {
  kind: ChangeKind;
  /** The value as the last load reported it. */
  reported: T;
  source: AccessTokenSource;
}) => {
  const { end } = useSession();
  const changed = useChanged();
  // A saved change holds only over the report it was made against, so the
  // next load's report replaces it rather than being masked by it.
  const [saved, setSaved] = useState<{ over: T; value: T } | null>(null);
  const [value, show] = useOptimistic(
    saved !== null && saved.over === reported ? saved.value : reported,
  );
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [saving, startSaving] = useTransition();

  const write = (
    next: T,
    save: () => Promise<Result<unknown, ApiError>>,
  ): void => {
    startSaving(async () => {
      setFailure(null);
      show(next);
      const outcome = await save();
      if (Result.isOk(outcome)) {
        setSaved({ over: reported, value: next });
        changed(kind);
        return;
      }
      if (outcome.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(outcome.error));
    });
  };

  return { failure, saving, value, write };
};
