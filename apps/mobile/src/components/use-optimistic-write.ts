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
 * status. The change shows at once; once saved it stays until the next load
 * replaces the one it was made against, and the lists of `kind` load afresh. A change that
 * does not save goes back, with why, for `WriteFailureNotice`.
 */
export const useOptimisticWrite = <T extends boolean | string>({
  from,
  kind,
  reported,
  source,
}: {
  /** What the last load returned; a saved change holds over that load only. */
  from: object;
  kind: ChangeKind;
  /** The value as that load reported it. */
  reported: T;
  source: AccessTokenSource;
}) => {
  const { end } = useSession();
  const changed = useChanged();
  // Held by the load's identity, not its value: any later load replaces the
  // change, even one that reports the value from before it again.
  const [saved, setSaved] = useState<
    { type: "none" } | { type: "held"; from: object; value: T }
  >({ type: "none" });
  const [value, show] = useOptimistic(
    saved.type === "held" && saved.from === from ? saved.value : reported,
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
        setSaved({ type: "held", from, value: next });
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
