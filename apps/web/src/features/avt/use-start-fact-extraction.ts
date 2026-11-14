import * as React from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { runSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import type { RunSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import { startRefusalKey } from "@/features/avt/fact-extraction.logic";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { toSafeId } from "@/lib/safe-id";
import { legalListKeys } from "@/lib/workspaces/queries/legal-lists";

export type FactExtractionRequest = {
  entityIds: readonly string[];
  instruction: string;
  /** The estimate the reviewer agreed to, after a size confirmation. */
  confirmedUnits?: number;
};

export type FactExtractionStart =
  | { type: "started"; runId: string }
  | { type: "confirm"; detail: RunSizeConfirmationDetail }
  | { type: "refused" };

/**
 * Start reading facts out of the chosen documents into the view's list. A run
 * large enough to need a go-ahead comes back as `confirm` with its estimate;
 * the caller repeats the request with `confirmedUnits` once the reviewer
 * agrees.
 */
export const useStartFactExtraction = ({
  workspaceId,
  listId,
}: {
  workspaceId: string;
  listId: string;
}) => {
  const submit = useIdempotentSubmit();
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [starting, setStarting] = React.useState(false);

  const start = async ({
    entityIds,
    instruction,
    confirmedUnits,
  }: FactExtractionRequest): Promise<FactExtractionStart> => {
    setStarting(true);
    const trimmed = instruction.trim();
    const endpoint = api.lists({
      workspaceId: toSafeId<"workspace">(workspaceId),
    })["fact-extractions"];
    const sent = await Result.tryPromise(async () => {
      const { data, error } = await submit.run({
        operation: `fact-extraction-create:${workspaceId}`,
        send: endpoint.post,
        body: {
          listId: toSafeId<"legalList">(listId),
          entityIds: entityIds.map((id) => toSafeId<"entity">(id)),
          ...(trimmed === "" ? {} : { instruction: trimmed }),
          ...(confirmedUnits === undefined ? {} : { confirmedUnits }),
        },
      });
      return error ? { data: null, error } : { data, error: null };
    });
    setStarting(false);

    if (Result.isError(sent)) {
      // The request never got an answer (network, aborted transport).
      notifyUserError(sent.error, t("avt.extraction.startFailed"), {
        description: t("common.unexpectedError"),
      });
      return { type: "refused" };
    }
    const response = sent.value;
    if (response.error) {
      const detail =
        "kind" in response.error
          ? null
          : runSizeConfirmationDetail(response.error);
      if (detail !== null) {
        return { type: "confirm", detail };
      }
      const apiError = toAPIError(response.error);
      const refusalKey = startRefusalKey(apiError.code);
      notifyUserError(
        apiError,
        t("avt.extraction.startFailed"),
        refusalKey === null ? undefined : { description: t(refusalKey) },
      );
      return { type: "refused" };
    }

    await queryClient.invalidateQueries({
      queryKey: legalListKeys.generations(workspaceId, listId),
    });
    return { type: "started", runId: response.data.runId };
  };

  return { start, starting };
};
