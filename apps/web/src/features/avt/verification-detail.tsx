/**
 * One verification of one document: waiting while it runs, the reason when it
 * failed, and the claims to review once it completed.
 */

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowLeftIcon, PlayIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { Skeleton } from "@stll/ui/skeleton";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { RunSizeConfirmDialog } from "@/components/usage/run-size-confirm-dialog";
import { verificationRunOptions } from "@/features/avt/queries";
import { RunHistoryPicker } from "@/features/avt/run-history-picker";
import type { VerificationRun } from "@/features/avt/types";
import { RUN_ERROR_KEYS } from "@/features/avt/types";
import { useStartVerification } from "@/features/avt/use-start-verification";
import { VerificationView } from "@/features/avt/verification-view";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
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
  const filesQuery = useQuery(workspaceFilesOptions(workspaceId));
  const filesView = useQueryView(filesQuery);
  useQueryViewError(filesView);
  const files = filesView.type === "items" ? filesView.items : undefined;
  // The document as it stands now: an earlier run may pin a file field a
  // newer version replaced, and history and re-verification follow the
  // current one.
  const currentFile =
    run === undefined
      ? undefined
      : files?.find((file) => file.entityId === run.entityId);
  const documentName = currentFile?.name ?? null;

  return (
    <>
      <QueryViewFeedback view={filesView} />
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
        {run !== undefined && (
          <RunHistoryPicker
            fileFieldId={currentFile?.fieldId ?? run.fileFieldId}
            listId={listId}
            onOpenRun={onOpenRun}
            run={run}
            workspaceId={workspaceId}
          />
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
          currentFileFieldId={currentFile?.fieldId ?? null}
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
  /** Null while the matter's files load or once the document is gone. */
  currentFileFieldId: string | null;
  listId: string | null;
  onOpenRun: (runId: string) => void;
};

const RunBody = ({
  workspaceId,
  run,
  currentFileFieldId,
  listId,
  onOpenRun,
}: RunBodyProps) => {
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
          {listId !== null && currentFileFieldId !== null && (
            <VerifyAgain
              entityId={run.entityId}
              fileFieldId={currentFileFieldId}
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
        confirmLabel={t("common.verify")}
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
