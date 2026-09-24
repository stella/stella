import * as React from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { runSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import type { RunSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import {
  avtKeys,
  documentFileKey,
  latestVerificationsOptions,
} from "@/features/avt/queries";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";

const RUN_ALREADY_ACTIVE_STATUS = 409;

export type VerificationTarget = {
  entityId: string;
  fileFieldId: string;
};

type StartVerificationArgs = {
  workspaceId: string;
  listId: string;
  onStarted: (runId: string) => void;
};

type SizeConfirmation = RunSizeConfirmationDetail & {
  target: VerificationTarget;
};

/**
 * Start verifying one document against the view's list. A run large enough
 * to need a go-ahead parks its request until the reviewer confirms the size;
 * a document that is already being verified opens that run instead.
 */
export const useStartVerification = ({
  workspaceId,
  listId,
  onStarted,
}: StartVerificationArgs) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [startingFor, setStartingFor] =
    React.useState<VerificationTarget | null>(null);
  const [sizeConfirmation, setSizeConfirmation] =
    React.useState<SizeConfirmation | null>(null);

  const start = async (target: VerificationTarget, confirmedUnits?: number) => {
    setSizeConfirmation(null);
    setStartingFor(target);
    const sent = await Result.tryPromise(async () => {
      const { data, error } = await api
        .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .verifications.post({
          listId: toSafeId<"legalList">(listId),
          entityId: toSafeId<"entity">(target.entityId),
          fileFieldId: toSafeId<"field">(target.fileFieldId),
          ...(confirmedUnits === undefined ? {} : { confirmedUnits }),
        });
      return error ? { data: null, error } : { data, error: null };
    });
    setStartingFor(null);

    if (Result.isError(sent)) {
      // The request never got an answer (network, aborted transport).
      stellaToast.add({
        type: "error",
        title: t("avt.runs.startFailed"),
        description: t("common.unexpectedError"),
      });
      return;
    }
    const response = sent.value;

    if (response.error) {
      const detail = runSizeConfirmationDetail(response.error);
      if (detail !== null) {
        setSizeConfirmation({ ...detail, target });
        return;
      }
      if (response.error.status === RUN_ALREADY_ACTIVE_STATUS) {
        // Another tab (or a reload that raced this click) already started a
        // run for this document: open that one.
        await queryClient.invalidateQueries({
          queryKey: avtKeys.latestAll(workspaceId),
        });
        const latest = await Result.tryPromise(
          async () =>
            await queryClient.query(
              latestVerificationsOptions({
                workspaceId,
                documents: [target],
              }),
            ),
        );
        const active = Result.isError(latest)
          ? null
          : (latest.value.get(documentFileKey(target)) ?? null);
        if (active?.status === "queued" || active?.status === "running") {
          onStarted(active.id);
          return;
        }
      }
      stellaToast.add({
        type: "error",
        title: t("avt.runs.startFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    await queryClient.invalidateQueries({
      queryKey: avtKeys.latestAll(workspaceId),
    });
    onStarted(response.data.runId);
  };

  return {
    start,
    startingFor,
    sizeConfirmation,
    dismissSizeConfirmation: () => setSizeConfirmation(null),
  };
};
