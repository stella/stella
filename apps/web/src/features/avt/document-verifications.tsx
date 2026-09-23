/**
 * The matter's documents, each with its latest verification and a way to
 * start one against the view's list.
 */

import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { FileCheckIcon, PlayIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";

import { RunSizeConfirmDialog } from "@/components/usage/run-size-confirm-dialog";
import {
  documentFileKey,
  latestVerificationsOptions,
} from "@/features/avt/queries";
import type {
  VerificationRunStatus,
  VerificationRunSummary,
} from "@/features/avt/types";
import { RUN_STATUS_LABEL_KEYS } from "@/features/avt/types";
import type { VerificationTarget } from "@/features/avt/use-start-verification";
import { useStartVerification } from "@/features/avt/use-start-verification";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import type { WorkspaceFile } from "@/lib/workspaces/queries/entities";
import { workspaceFilesOptions } from "@/lib/workspaces/queries/entities";

type DocumentVerificationsProps = {
  workspaceId: string;
  listId: string;
  onOpenRun: (runId: string) => void;
};

export const DocumentVerifications = ({
  workspaceId,
  listId,
  onOpenRun,
}: DocumentVerificationsProps) => {
  const t = useTranslations();
  const { data: files } = useSuspenseQuery(workspaceFilesOptions(workspaceId));
  const verification = useStartVerification({
    workspaceId,
    listId,
    onStarted: onOpenRun,
  });
  const confirmation = verification.sizeConfirmation;
  const {
    data: latestByFile,
    isPending,
    isError,
    isRefetching,
    refetch,
  } = useQuery(
    latestVerificationsOptions({
      workspaceId,
      documents: files.map((file) => ({
        entityId: file.entityId,
        fileFieldId: file.fieldId,
      })),
    }),
  );

  if (files.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("avt.documents.empty")}
      </p>
    );
  }

  // Until the statuses load, a row cannot tell "never verified" from
  // "running", so it offers no verdict and no Verify.
  const statusLoad: StatusLoad = latestLoadState({ isPending, isError });

  return (
    <>
      {statusLoad === "failed" && (
        <div className="text-muted-foreground mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span>{t("avt.documents.statusLoadFailed")}</span>
          <Button
            loading={isRefetching}
            onClick={() => {
              detached(refetch(), "avt.refetch-latest-verifications");
            }}
            size="sm"
            variant="outline"
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      <ul className="divide-y rounded-xl border">
        {files.map((file) => (
          <DocumentRow
            file={file}
            key={`${file.entityId}:${file.fieldId}`}
            latest={
              latestByFile?.get(
                documentFileKey({
                  entityId: file.entityId,
                  fileFieldId: file.fieldId,
                }),
              ) ?? null
            }
            statusLoad={statusLoad}
            listId={listId}
            onOpenRun={onOpenRun}
            onVerify={(target) => {
              detached(verification.start(target), "avt.start-verification");
            }}
            starting={
              verification.startingFor?.entityId === file.entityId &&
              verification.startingFor.fileFieldId === file.fieldId
            }
          />
        ))}
      </ul>
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

type StatusLoad = "loading" | "failed" | "loaded";

const latestLoadState = ({
  isPending,
  isError,
}: {
  isPending: boolean;
  isError: boolean;
}): StatusLoad => {
  if (isError) {
    return "failed";
  }
  return isPending ? "loading" : "loaded";
};

type DocumentRowProps = {
  latest: VerificationRunSummary | null;
  statusLoad: StatusLoad;
  listId: string;
  file: WorkspaceFile;
  starting: boolean;
  onVerify: (target: VerificationTarget) => void;
  onOpenRun: (runId: string) => void;
};

const DocumentRow = ({
  latest,
  statusLoad,
  listId,
  file,
  starting,
  onVerify,
  onOpenRun,
}: DocumentRowProps) => {
  const t = useTranslations();
  const canVerify = usePermissions({ entity: ["update"] });
  const active = latest?.status === "queued" || latest?.status === "running";

  return (
    <li className="flex flex-col gap-2 p-3 md:flex-row md:items-center">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" dir="auto">
          {file.name ?? file.fileName}
        </p>
        {statusLoad === "loaded" && (
          <LatestRunSummary latest={latest} listId={listId} />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {latest !== null && (
          <Button
            onClick={() => onOpenRun(latest.id)}
            size="sm"
            variant="ghost"
          >
            <FileCheckIcon />
            {t("avt.documents.open")}
          </Button>
        )}
        <Button
          disabled={
            !canVerify || statusLoad !== "loaded" || active || starting
          }
          loading={starting}
          onClick={() =>
            onVerify({ entityId: file.entityId, fileFieldId: file.fieldId })
          }
          size="sm"
          variant="outline"
        >
          <PlayIcon />
          {latest === null
            ? t("avt.documents.verify")
            : t("avt.documents.verifyAgain")}
        </Button>
      </div>
    </li>
  );
};

const RUN_STATUS_TONES = {
  queued: "neutral",
  running: "neutral",
  completed: "success",
  failed: "destructive",
} as const satisfies Record<VerificationRunStatus, ReviewStatusTone>;

const LatestRunSummary = ({
  latest,
  listId,
}: {
  latest: VerificationRunSummary | null;
  listId: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  if (latest === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("avt.documents.notVerified")}
      </p>
    );
  }
  const { claimCounts } = latest;
  return (
    <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-xs">
      <ReviewStatusBadge tone={RUN_STATUS_TONES[latest.status]}>
        {t(RUN_STATUS_LABEL_KEYS[latest.status])}
      </ReviewStatusBadge>
      {latest.status === "completed" && (
        <span className="tabular-nums">
          {t("avt.documents.claimSummary", {
            contradicted: format.number(claimCounts.contradicted),
            tension: format.number(claimCounts.tension),
            conflicts: format.number(claimCounts.recordconflict),
          })}
        </span>
      )}
      {latest.listId !== listId && <span>{t("avt.documents.otherList")}</span>}
    </div>
  );
};
