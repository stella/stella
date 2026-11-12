import { useState, useTransition } from "react";

import { Result } from "better-result";

import { useChanged } from "@/components/changes";
import { writeFailure } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";

/**
 * One change to a matter at a time, from its info screen: while one is
 * saving the controls hold still, a saved one has the matters load afresh
 * and runs `then`, and one that did not save says why, for
 * `WriteFailureNotice`. A session the server ended sends the person back to
 * sign in.
 */
export const useMatterWrite = (source: AccessTokenSource) => {
  const { end } = useSession();
  const changed = useChanged();
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [saving, startSaving] = useTransition();

  const write = <T>(
    save: () => Promise<Result<T, ApiError>>,
    then: (saved: T) => void,
  ): void => {
    startSaving(async () => {
      setFailure(null);
      const saved = await save();
      if (Result.isOk(saved)) {
        changed("matters");
        then(saved.value);
        return;
      }
      if (saved.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(saved.error));
    });
  };

  return { failure, saving, write };
};
