import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import type {
  DecisionQuestionSurface,
  QuestionColumnAction,
} from "@/features/case-law/components/decision-table";
import {
  createQuestionColumn,
  deleteQuestionColumn,
  questionAnswersOptions,
  questionColumnKeys,
  questionColumnsOptions,
  runAnswers,
  updateQuestionColumn,
} from "@/features/case-law/research/queries";
import {
  answerKey,
  NO_QUESTION_ANSWERS,
  NO_QUESTION_COLUMNS,
  questionColumnSurface,
  questionRunSet,
} from "@/features/case-law/research/question-columns.logic";
import type {
  QuestionAnswer,
  QuestionColumn,
  QuestionDraft,
  QuestionRunSet,
} from "@/features/case-law/research/question-columns.logic";
import { ResearchQuestionDialog } from "@/features/case-law/research/research-question-dialog";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";

/**
 * The organization's question columns on the results page: what the table
 * draws, and what the reader can add, edit, remove and run.
 *
 * The hook holds the state because two places need it — the table's own column
 * headers and the toolbar's controls — and a controller passed between them is
 * cheaper than a context nobody else reads.
 */

type QuestionColumnsInput = {
  /**
   * Whether this surface asks questions at all. A surface that may hold no
   * rows — a matter with nothing linked — passes what it already knows, so the
   * organization's columns are never read speculatively on a route that will
   * not draw them.
   */
  enabled: boolean;
  /** Every decision on the page, in the order it is drawn. */
  pageDecisionIds: readonly string[];
  /** The rows the reader picked; empty means the whole page. */
  selectedDecisionIds: readonly string[];
  /** Where the "show source" link should take the reader. */
  onShowSource: DecisionQuestionSurface["onShowSource"];
};

/** Which question the dialog edits, or that it adds one. */
type QuestionDialogState =
  | { type: "closed" }
  | { type: "create" }
  | { type: "edit"; column: QuestionColumn };

/** One queue request: a confirmed run, or the retry of a single failed cell. */
type RunRequest = {
  /** Answer again where an answer already stands. */
  force: boolean;
  runSet: QuestionRunSet;
};

/** A run the reader has been shown the size of and has not yet confirmed. */
type PendingRun = {
  runSet: QuestionRunSet;
  /** Named so the toast and the dialog can say which question is being asked. */
  question: string | null;
};

export type QuestionColumnsController = {
  /** Null for a reader without an organization: no columns, no controls. */
  surface: DecisionQuestionSurface | null;
  draft: QuestionDialogState;
  onDraftChange: (draft: QuestionDialogState) => void;
  onSubmitDraft: (draft: QuestionDraft) => void;
  isSaving: boolean;
  pendingRun: PendingRun | null;
  onCancelRun: () => void;
  onConfirmRun: () => void;
  /** Asks every question of every row on the page that lacks an answer. */
  onRunAll: () => void;
  removing: QuestionColumn | null;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
};

export const useQuestionColumns = ({
  enabled,
  onShowSource,
  pageDecisionIds,
  selectedDecisionIds,
}: QuestionColumnsInput): QuestionColumnsController => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const authStatus = useClientAuthStatus();
  const activeOrganizationId = authStatus.isAuthenticated
    ? authStatus.user.activeOrganizationId
    : null;

  const [draft, setDraft] = useState<QuestionDialogState>({ type: "closed" });
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);
  const [removing, setRemoving] = useState<QuestionColumn | null>(null);

  const { data: columns } = useQuery({
    ...questionColumnsOptions({
      activeOrganizationId: activeOrganizationId ?? "",
    }),
    enabled: enabled && activeOrganizationId !== null,
  });
  // Sorted, so the same page asks the same cache question whatever order the
  // rows arrived in.
  const decisionIds = [...pageDecisionIds].toSorted();
  const { data: answers } = useQuery({
    ...questionAnswersOptions({
      activeOrganizationId: activeOrganizationId ?? "",
      decisionIds,
    }),
    enabled: enabled && activeOrganizationId !== null && decisionIds.length > 0,
  });

  const asked = columns ?? NO_QUESTION_COLUMNS;
  const surface = questionColumnSurface({
    columns: asked,
    hasActiveOrganization: activeOrganizationId !== null,
  });

  const answersByKey = new Map<string, QuestionAnswer>();
  for (const answer of answers ?? NO_QUESTION_ANSWERS) {
    answersByKey.set(answerKey(answer.columnId, answer.decisionId), answer);
  }

  const reportFailure = (error: unknown) => {
    analytics.captureError(error);
    stellaToast.add({ title: t("common.somethingWentWrong"), type: "error" });
  };

  const invalidateColumns = async () => {
    await queryClient.invalidateQueries({ queryKey: questionColumnKeys.all });
  };

  const save = useMutation({
    mutationFn: async (input: QuestionDraft & { columnId?: string }) =>
      input.columnId === undefined
        ? await createQuestionColumn({
            answerType: input.answerType,
            question: input.question,
          })
        : await updateQuestionColumn({
            answerType: input.answerType,
            columnId: input.columnId,
            question: input.question,
          }),
    onSuccess: async () => {
      setDraft({ type: "closed" });
      await invalidateColumns();
    },
    onError: reportFailure,
  });

  const remove = useMutation({
    mutationFn: async (columnId: string) =>
      await deleteQuestionColumn(columnId),
    onSuccess: async () => {
      setRemoving(null);
      await invalidateColumns();
    },
    onError: reportFailure,
  });

  // `force` is the retry of one cell that already holds a failure: the server
  // treats anything but `pending` as answered, so without it a failed cell
  // would be skipped and the retry would do nothing.
  const run = useMutation({
    mutationFn: async ({ force, runSet }: RunRequest) =>
      await runAnswers({
        columnIds: runSet.columnIds,
        decisionIds: runSet.decisionIds,
        ...(force ? { force: true } : {}),
      }),
    onSuccess: async ({ queued }) => {
      setPendingRun(null);
      stellaToast.add({
        title: t("caseLaw.research.answering", { count: queued }),
        type: "success",
      });
      await invalidateColumns();
    },
    onError: reportFailure,
  });

  /** Ask for a run, or say there is nothing to ask; never run silently. */
  const askToRun = (column: QuestionColumn | null) => {
    const runSet = questionRunSet({
      answersByKey,
      ...(column === null ? {} : { columnId: column.id }),
      columns: asked,
      pageDecisionIds,
      selectedDecisionIds,
    });
    if (runSet.cells === 0) {
      stellaToast.add({ title: t("caseLaw.research.nothingToRun") });
      return;
    }
    setPendingRun({
      runSet,
      question: column === null ? null : column.question,
    });
  };

  const onColumnAction = (
    column: QuestionColumn,
    action: QuestionColumnAction,
  ) => {
    switch (action) {
      case "run":
        askToRun(column);
        break;
      case "edit":
        setDraft({ type: "edit", column });
        break;
      case "delete":
        setRemoving(column);
        break;
      default:
        action satisfies never;
        panic(`Unhandled question column action: ${String(action)}`);
    }
  };

  return {
    surface:
      surface.type === "hidden"
        ? null
        : {
            answersByKey,
            columns: surface.columns,
            isRunning: run.isPending,
            onColumnAction,
            onRetryAnswer: (column, decisionId) => {
              detached(
                run.mutateAsync({
                  force: true,
                  runSet: {
                    columnIds: [column.id],
                    decisionIds: [decisionId],
                    cells: 1,
                  },
                }),
                "case-law-questions.retry-answer",
              );
            },
            onShowSource,
          },
    draft,
    onDraftChange: setDraft,
    onSubmitDraft: (submitted) => {
      detached(
        save.mutateAsync({
          ...submitted,
          ...(draft.type === "edit" ? { columnId: draft.column.id } : {}),
        }),
        "case-law-questions.save-column",
      );
    },
    isSaving: save.isPending,
    pendingRun,
    onCancelRun: () => setPendingRun(null),
    onConfirmRun: () => {
      if (pendingRun === null) {
        return;
      }
      detached(
        run.mutateAsync({ force: false, runSet: pendingRun.runSet }),
        "case-law-questions.run",
      );
    },
    onRunAll: () => askToRun(null),
    removing,
    onCancelRemove: () => setRemoving(null),
    onConfirmRemove: () => {
      if (removing === null) {
        return;
      }
      detached(
        remove.mutateAsync(removing.id),
        "case-law-questions.delete-column",
      );
    },
  };
};

/**
 * The toolbar half of the controller: adding a question, answering the page,
 * and the three dialogs those flows and the column headers share.
 *
 * Renders nothing at all for a reader without an organization — the same one
 * answer that hides the columns hides every control over them.
 */
export const QuestionColumnControls = ({
  controller,
}: {
  controller: QuestionColumnsController;
}) => {
  const t = useTranslations();

  if (controller.surface === null) {
    return null;
  }
  const { pendingRun, removing, surface } = controller;

  return (
    <>
      <Button
        className="h-7 min-h-0 text-xs"
        onClick={() => controller.onDraftChange({ type: "create" })}
        size="sm"
        variant="outline"
      >
        {t("caseLaw.research.addColumn")}
      </Button>
      {surface.columns.length > 0 && (
        <Button
          className="text-muted-foreground h-7 min-h-0 text-xs"
          disabled={surface.isRunning}
          onClick={controller.onRunAll}
          size="sm"
          variant="ghost"
        >
          {t("caseLaw.research.runAll")}
        </Button>
      )}

      {controller.draft.type !== "closed" && (
        <ResearchQuestionDialog
          // A new dialog per question, so the fields start from what is being
          // edited rather than from whatever was typed last.
          key={
            controller.draft.type === "edit"
              ? controller.draft.column.id
              : "new"
          }
          {...(controller.draft.type === "edit"
            ? {
                initial: {
                  answerType: controller.draft.column.answerType,
                  question: controller.draft.column.question,
                },
              }
            : {})}
          isPending={controller.isSaving}
          onOpenChange={(open) => {
            if (!open) {
              controller.onDraftChange({ type: "closed" });
            }
          }}
          onSubmit={controller.onSubmitDraft}
          open
        />
      )}

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            controller.onCancelRun();
          }
        }}
        open={pendingRun !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("caseLaw.research.runTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRun === null
                ? ""
                : t("caseLaw.research.runEstimate", {
                    cells: pendingRun.runSet.cells,
                    columns: pendingRun.runSet.columnIds.length,
                    rows: pendingRun.runSet.decisionIds.length,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={surface.isRunning}
              onClick={controller.onConfirmRun}
            >
              {t("caseLaw.research.runConfirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            controller.onCancelRemove();
          }
        }}
        open={removing !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("caseLaw.research.deleteColumn")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("caseLaw.research.deleteColumnConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button onClick={controller.onConfirmRemove} variant="destructive">
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
};
