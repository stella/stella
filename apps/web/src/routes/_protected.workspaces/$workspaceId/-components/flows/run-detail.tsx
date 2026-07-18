import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, FileTextIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import { Label } from "@stll/ui/components/label";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { MessageResponse } from "@/components/ai-elements/message";
import { openEntityInInspector } from "@/components/chat/entity-open";
import {
  FlowStepStatusBadge,
  FlowStatusBadge,
} from "@/components/flows/flow-badges";
import {
  FLOW_STEP_KIND_ICONS,
  FLOW_STEP_KIND_LABEL_KEYS,
  isTerminalFlowRunStatus,
} from "@/components/flows/flow-meta";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import type {
  FlowRunDetail as FlowRunDetailData,
  FlowRunStepRun,
} from "@/routes/_protected.workspaces/$workspaceId/-components/flows/flow-run-types";
import {
  flowRunDetailOptions,
  flowRunsKeys,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/flow-runs";

type RunDetailProps = {
  workspaceId: string;
  runId: string;
  onBack: () => void;
};

export const RunDetail = ({ workspaceId, runId, onBack }: RunDetailProps) => {
  const t = useTranslations();
  // Keep the whole query result (rather than destructuring `data` alongside
  // `isPending`/`isError`) so TypeScript narrows `query.data` through the
  // same object instead of leaving it at its full pre-narrowed union type.
  const query = useQuery(flowRunDetailOptions(workspaceId, runId));

  if (query.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </div>
    );
  }

  // The Eden response type for this endpoint can also resolve to a raw
  // `Response` (see flow-run-types.ts); guard it the same way sibling flow
  // queries do so `query.data` narrows to `FlowRunDetailData` below.
  if (query.isError || !query.data || query.data instanceof Response) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-6">
        <BackButton onBack={onBack} />
        <p className="text-muted-foreground text-sm">
          {t("flows.runs.loadFailed")}
        </p>
      </div>
    );
  }

  return (
    <RunDetailContent
      onBack={onBack}
      run={query.data}
      workspaceId={workspaceId}
    />
  );
};

const BackButton = ({ onBack }: { onBack: () => void }) => {
  const t = useTranslations();
  return (
    <Button
      className="self-start"
      onClick={onBack}
      size="sm"
      type="button"
      variant="ghost"
    >
      <ArrowLeftIcon />
      {t("common.back")}
    </Button>
  );
};

const RunDetailContent = ({
  run,
  workspaceId,
  onBack,
}: {
  run: FlowRunDetailData;
  workspaceId: string;
  onBack: () => void;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const canRun = usePermissions({ flow: ["run"] });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const isActive = !isTerminalFlowRunStatus(run.status);

  const handleCancel = async () => {
    setCancelling(true);
    const response = await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .flows.runs({ runId: toSafeId<"flowRun">(run.id) })
      .cancel.post({ queryKey: flowRunsKeys.all(workspaceId) });
    setCancelling(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("flows.runs.cancelFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({ type: "success", title: t("flows.runs.cancelled") });
    setCancelOpen(false);
    void queryClient.invalidateQueries({
      queryKey: flowRunsKeys.all(workspaceId),
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-2">
        <BackButton onBack={onBack} />
        {isActive && canRun && (
          <AlertDialog onOpenChange={setCancelOpen} open={cancelOpen}>
            <Button
              onClick={() => setCancelOpen(true)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("flows.runs.cancel")}
            </Button>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("flows.runs.cancel")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("flows.runs.confirmCancel")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>
                  {t("common.cancel")}
                </AlertDialogClose>
                <Button
                  disabled={cancelling}
                  onClick={() => {
                    void handleCancel();
                  }}
                  variant="destructive"
                >
                  {t("flows.runs.cancel")}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        )}
      </div>

      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold" dir="auto">
          {run.name}
        </h1>
        <FlowStatusBadge status={run.status} />
      </div>

      {run.error && (
        <div className="rounded-lg bg-[var(--option-red-bg)] px-3 py-2 text-sm text-[var(--option-red-fg)]">
          {run.error}
        </div>
      )}

      {run.status === "awaiting_review" && (
        <ReviewGateCard
          onResolved={() => {
            void queryClient.invalidateQueries({
              queryKey: flowRunsKeys.all(workspaceId),
            });
          }}
          run={run}
          workspaceId={workspaceId}
        />
      )}

      <ol className="flex flex-col gap-3">
        {run.stepRuns.map((stepRun) => (
          <StepRunCard
            key={stepRun.index}
            run={run}
            stepRun={stepRun}
            workspaceId={workspaceId}
          />
        ))}
      </ol>
    </div>
  );
};

const StepRunCard = ({
  stepRun,
  run,
  workspaceId,
}: {
  stepRun: FlowRunStepRun;
  run: FlowRunDetailData;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const definitionStep = run.steps.at(stepRun.index);
  const Icon = FLOW_STEP_KIND_ICONS[stepRun.kind];

  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {format.number(stepRun.index + 1)}
          </span>
          <Icon className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate text-sm font-medium" dir="auto">
            {definitionStep?.name || t(FLOW_STEP_KIND_LABEL_KEYS[stepRun.kind])}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {stepRun.finishedAt && (
            <span className="text-muted-foreground text-xs tabular-nums">
              {format.dateTime(new Date(stepRun.finishedAt), {
                timeStyle: "short",
              })}
            </span>
          )}
          <FlowStepStatusBadge status={stepRun.status} />
        </div>
      </div>

      {stepRun.error && (
        <p className="text-xs text-[var(--option-red-fg)]">{stepRun.error}</p>
      )}

      <StepRunOutput output={stepRun.output} workspaceId={workspaceId} />
    </li>
  );
};

const StepRunOutput = ({
  output,
  workspaceId,
}: {
  output: FlowRunStepRun["output"];
  workspaceId: string;
}) => {
  const t = useTranslations();

  if (!output) {
    return null;
  }

  if (output.kind === "ai") {
    return (
      <div className="border-t pt-2 text-sm">
        <MessageResponse>{output.markdown}</MessageResponse>
      </div>
    );
  }

  if (output.kind === "create-document") {
    return (
      <Button
        onClick={() => {
          void openEntityInInspector(
            output.entityId,
            t("flows.runs.createdDocument"),
            workspaceId,
          );
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        <FileTextIcon />
        {t("flows.runs.openDocument")}
      </Button>
    );
  }

  if (output.kind === "review-gate") {
    return (
      <p className="text-muted-foreground text-xs">
        {output.decision === "approved"
          ? t("flows.runs.review.approved")
          : t("flows.runs.review.rejected")}
        {output.note ? ` — ${output.note}` : ""}
      </p>
    );
  }

  return null;
};

const ReviewGateCard = ({
  run,
  workspaceId,
  onResolved,
}: {
  run: FlowRunDetailData;
  workspaceId: string;
  onResolved: () => void;
}) => {
  const t = useTranslations();
  const canReview = usePermissions({ flow: ["review"] });
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const currentStep = run.steps.at(run.currentStepIndex);
  const instructions =
    currentStep?.kind === "review-gate" ? currentStep.instructions : "";

  // The most recent AI output before the gate, for review context.
  const priorMarkdown = run.stepRuns
    .filter(
      (step) => step.index < run.currentStepIndex && step.output?.kind === "ai",
    )
    .map((step) => (step.output?.kind === "ai" ? step.output.markdown : ""))
    .at(-1);

  const submit = async (decision: "approved" | "rejected") => {
    setSubmitting(true);
    const trimmedNote = note.trim();
    const response = await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .flows.runs({ runId: toSafeId<"flowRun">(run.id) })
      .review.post({
        decision,
        note: trimmedNote === "" ? null : trimmedNote,
        queryKey: flowRunsKeys.all(workspaceId),
      });
    setSubmitting(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("flows.runs.review.failed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title:
        decision === "approved"
          ? t("flows.runs.review.approved")
          : t("flows.runs.review.rejected"),
    });
    onResolved();
  };

  return (
    <div className="space-y-3 rounded-lg border border-[var(--option-amber-fg)]/40 bg-[var(--option-amber-bg)]/40 p-4">
      <div>
        <h2 className="text-sm font-semibold">
          {t("flows.runs.review.title")}
        </h2>
        {instructions && (
          <p className="text-muted-foreground mt-1 text-sm whitespace-pre-wrap">
            {instructions}
          </p>
        )}
      </div>

      {priorMarkdown && (
        <div className="bg-background/60 rounded-md border p-3 text-sm">
          <p className="text-muted-foreground mb-1 text-xs font-medium">
            {t("flows.runs.review.priorOutput")}
          </p>
          <MessageResponse>{priorMarkdown}</MessageResponse>
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="flow-review-note">{t("flows.runs.review.note")}</Label>
        <Textarea
          className="min-h-[60px]"
          id="flow-review-note"
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("flows.runs.review.notePlaceholder")}
          value={note}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button
          disabled={!canReview || submitting}
          onClick={() => {
            void submit("rejected");
          }}
          type="button"
          variant="outline"
        >
          {t("flows.runs.review.reject")}
        </Button>
        <Button
          disabled={!canReview || submitting}
          loading={submitting}
          onClick={() => {
            void submit("approved");
          }}
          type="button"
        >
          {t("flows.runs.review.approve")}
        </Button>
      </div>
    </div>
  );
};
