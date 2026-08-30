import { useEffect, useState } from "react";

import { Result } from "better-result";

import { readWorkspaces } from "@/api";
import { APIError, userErrorMessage } from "@/lib/api-error";
import type { WorkspaceSummary } from "@/types";

type UseWorkspaces = {
  error: string | null;
  workspaces: WorkspaceSummary[];
};

export const useWorkspaces = (errorFallback: string): UseWorkspaces => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const result = await Result.tryPromise(
        async () => await readWorkspaces(),
      );
      if (Result.isError(result)) {
        const { error: cause } = result;
        setError(
          cause instanceof APIError
            ? userErrorMessage(cause, errorFallback)
            : errorFallback,
        );
        return;
      }
      setWorkspaces(result.value);
      setError(null);
    })();
  }, [errorFallback]);

  return { error, workspaces };
};
