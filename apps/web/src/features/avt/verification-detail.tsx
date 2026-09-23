/**
 * One verification of one document: waiting while it runs, the reason when it
 * failed, and the claims to review once it completed.
 */

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { ArrowLeftIcon, PlayIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Loader } from "@stll/ui/loader";
import { Skeleton } from "@stll/ui/skeleton";

import { RunSizeConfirmDialog } from "@/components/usage/run-size-confirm-dialog";
import { verificationRunOptions } from "@/features/avt/queries";
import type { VerificationRun } from "@/features/avt/types";
import { RUN_ERROR_KEYS } from "@/features/avt/types";
import { useStartVerification } from "@/features/avt/use-start-verification";
import { VerificationView } from "@/features/avt/verification-view";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { workspaceFilesOptions } from "@/lib/workspaces/queries/entities";

type VerificationDetailProps = {
  workspaceId: string;
  runId: string;
  /** The view's list; verifying again checks against it. */
  listId: string | null;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
};

export const VerificationDetail = ({
  workspaceId,
  runId,
  listId,
  onBack,
  onOpenRun,
}: VerificationDetailProps) => {
  const t = useTranslations();
  const {
    data: run,
    isPending,
    isError,
  } = useQuery(verificationRunOptions(workspaceId, runId));
  const { data: files } = useQuery(workspaceFilesOptions(workspaceId));
  const documentName =
    run === undefined
      ? null
      : (files?.find((file) => file.entityId === run.entityId)?.name ?? null);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onBack} size="sm" variant="ghost">
          <DirectionalIcon icon={ArrowLeftIcon} />
          {t("avt.runs.back")}
        </Button>
        {documentName !== null && (
          <h2
            className="min-w-0 flex-1 truncate text-base font-semibold"
            dir="auto"
          >
            {documentName}
          </h2>
        )}
      </div>
      {isPending && <Skeleton className="h-40 w-full" />}
      {isError && (
        <p className="text-muted-foreground text-sm">
          {t("avt.runs.loadFailed")}
        </p>
      )}
      {run !== undefined && (
        <RunBody
          listId={listId}
          onOpenRun={onOpenRun}
          run={run}
          workspaceId={workspaceId}
        />
      )}
    </>
  );
};

type RunBodyProps = {
  workspaceId: string;
  run: VerificationRun;
  listId: string | null;
  onOpenRun: (runId: string) => void;
};

const RunBody = ({ workspaceId, run, listId, onOpenRun }: RunBodyProps) => {
  const t = useTranslations();
  const format = useFormatter();

  switch (run.status) {
    case "queued":
    case "running": {
      return (
        <div className="text-muted-foreground flex items-center gap-2 rounded-lg border p-4 text-sm">
          <Loader label={t("avt.runs.inProgress")} />
          {t("avt.runs.inProgress")}
        </div>
      );
    }
    case "failed": {
      return (
        <div className="space-y-3 rounded-lg border p-4">
          <h3 className="text-sm font-semibold">{t("avt.runs.failedTitle")}</h3>
          <p className="text-muted-foreground text-sm">
            {t(RUN_ERROR_KEYS[run.errorCode ?? "internal"])}
          </p>
          {listId !== null && (
            <VerifyAgain
              entityId={run.entityId}
              fileFieldId={run.fileFieldId}
              listId={listId}
              onOpenRun={onOpenRun}
              workspaceId={workspaceId}
            />
          )}
        </div>
      );
    }
    case "completed": {
      const checkedAt = format.dateTime(
        Temporal.Instant.from(run.createdAt).epochMilliseconds,
        MEDIUM_DATE_SHORT_TIME_FORMAT,
      );
      return (
        <>
          <p className="text-muted-foreground text-xs">
            {t("avt.runs.evidencePinned", {
              count: run.evidence.facts.length,
              checkedAt,
            })}
          </p>
          {run.claims.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("avt.runs.noClaims")}
            </p>
          ) : (
            <VerificationView run={run} workspaceId={workspaceId} />
          )}
        </>
      );
    }
    default: {
      run.status satisfies never;
      return panic(`Unhandled verification status: ${String(run.status)}`);
    }
  }
};

type VerifyAgainProps = {
  workspaceId: string;
  listId: string;
  entityId: string;
  fileFieldId: string;
  onOpenRun: (runId: string) => void;
};

const VerifyAgain = ({
  workspaceId,
  listId,
  entityId,
  fileFieldId,
  onOpenRun,
}: VerifyAgainProps) => {
  const t = useTranslations();
  const canVerify = usePermissions({ entity: ["update"] });
  const verification = useStartVerification({
    workspaceId,
    listId,
    onStarted: onOpenRun,
  });
  const confirmation = verification.sizeConfirmation;
  const target = { entityId, fileFieldId };

  return (
    <>
      <Button
        disabled={!canVerify || verification.startingFor !== null}
        loading={verification.startingFor !== null}
        onClick={() => {
          detached(verification.start(target), "avt.verify-again");
        }}
        size="sm"
        variant="outline"
      >
        <PlayIcon />
        {t("avt.documents.verifyAgain")}
      </Button>
      <RunSizeConfirmDialog
        confirmLabel={t("avt.documents.verify")}
        detail={confirmation}
        onConfirm={() => {
          if (confirmation === null) {
            return;
          }
          detached(
            verification.start(
              confirmation.target,
              confirmation.estimatedUnits,
            ),
            "avt.confirm-verification-size",
          );
        }}
        onDismiss={verification.dismissSizeConfirmation}
        title={t("avt.documents.sizeConfirmTitle")}
      />
    </>
  );
};
