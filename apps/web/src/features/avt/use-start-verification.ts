import * as React from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { isVerificationScopeRefusal } from "@stll/api-contract/verification-scope";
import type { VerificationScopeRefusal } from "@stll/api-contract/verification-scope";

import { runSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import type { RunSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import {
  avtKeys,
  documentFileKey,
  latestVerificationsOptions,
} from "@/features/avt/queries";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { toSafeId } from "@/lib/safe-id";

const RUN_ALREADY_ACTIVE_STATUS = 409;

export type VerificationTarget = {
  entityId: string;
  fileFieldId: string;
  /** A paragraph range as the API takes it (`82-136`); absent for the
   *  whole document. */
  paragraphs?: string;
};

/** A range the server refused when the run was asked for: told to the
 *  reviewer beside the range they typed, not as a toast. */
export type ScopeRefusal = {
  target: VerificationTarget;
  code: VerificationScopeRefusal;
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
  const submit = useIdempotentSubmit();
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [startingFor, setStartingFor] =
    React.useState<VerificationTarget | null>(null);
  const [sizeConfirmation, setSizeConfirmation] =
    React.useState<SizeConfirmation | null>(null);
  const [scopeRefusal, setScopeRefusal] = React.useState<ScopeRefusal | null>(
    null,
  );

  const start = async (target: VerificationTarget, confirmedUnits?: number) => {
    setSizeConfirmation(null);
    setScopeRefusal(null);
    setStartingFor(target);
    const sent = await Result.tryPromise(async () => {
      const { data, error } = await submit.run({
        operation: `verification-create:${workspaceId}`,
        send: async (body) =>
          api
            .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
            .verifications.post(body),
        body: {
          listId: toSafeId<"legalList">(listId),
          entityId: toSafeId<"entity">(target.entityId),
          fileFieldId: toSafeId<"field">(target.fileFieldId),
          ...(target.paragraphs === undefined
            ? {}
            : { paragraphs: target.paragraphs }),
          ...(confirmedUnits === undefined ? {} : { confirmedUnits }),
        },
      });
      return error ? { data: null, error } : { data, error: null };
    });
    setStartingFor(null);

    if (Result.isError(sent)) {
      // The request never got an answer (network, aborted transport).
      notifyUserError(sent.error, t("avt.runs.startFailed"), {
        description: t("common.unexpectedError"),
      });
      return;
    }
    const response = sent.value;

    if (response.error) {
      if ("kind" in response.error) {
        notifyUserError(toAPIError(response.error), t("avt.runs.startFailed"), {
          description: t("common.unexpectedError"),
        });
        return;
      }
      const detail = runSizeConfirmationDetail(response.error);
      if (detail !== null) {
        setSizeConfirmation({ ...detail, target });
        return;
      }
      const { code } = toAPIError(response.error);
      if (isVerificationScopeRefusal(code)) {
        setScopeRefusal({ target, code });
        return;
      }
      if (response.error.status === RUN_ALREADY_ACTIVE_STATUS) {
        // Another tab (or a reload that raced this click) already started a
        // run for this document: open that one.
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: avtKeys.latestAll(workspaceId),
          }),
          queryClient.invalidateQueries({
            queryKey: avtKeys.historyAll(workspaceId),
          }),
        ]);
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
      notifyUserError(toAPIError(response.error), t("avt.runs.startFailed"));
      return;
    }

    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: avtKeys.latestAll(workspaceId),
      }),
      queryClient.invalidateQueries({
        queryKey: avtKeys.historyAll(workspaceId),
      }),
    ]);
    onStarted(response.data.runId);
  };

  return {
    start,
    startingFor,
    sizeConfirmation,
    scopeRefusal,
    clearScopeRefusal: () => setScopeRefusal(null),
    dismissSizeConfirmation: () => {
      submit.reset();
      setSizeConfirmation(null);
    },
  };
};
