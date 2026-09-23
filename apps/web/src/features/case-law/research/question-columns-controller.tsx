/**
 * The organization's question columns on a decision table: which of them this
 * search draws, and what the reader can add, edit, remove and run.
 *
 * The hook holds the state because two places need it — the table's own column
 * headers and the toolbar's controls — and a controller passed between them is
 * cheaper than a context nobody else reads.
 */

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

import { BulkAddColumns } from "@/components/workspaces/bulk-add-columns";
import type { Decision } from "@/features/case-law/components/decision-cells";
import { AddQuestionColumn } from "@/features/case-law/research/add-question-column";
import {
  deleteQuestionColumn,
  questionAnswersOptions,
  questionColumnKeys,
  questionColumnsOptions,
  runAnswers,
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
  QuestionColumnAction,
  QuestionColumnGrants,
  QuestionColumnSurface,
  QuestionRunSet,
  QuestionSuggestionSearch,
} from "@/features/case-law/research/question-columns.logic";
import {
  questionsOnSearch,
  withoutQuestionOnSearch,
  withQuestionsOnSearch,
} from "@/features/case-law/research/search-questions.logic";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";

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
  /**
   * The search these rows came from. It grounds a new question's suggested
   * wording; a surface whose rows were never searched for passes
   * `UNSEARCHED_SCOPE`.
   */
  search: QuestionSuggestionSearch;
  /** Opens a decision at a cited passage, with the reader's highlight. */
  onShowPassage: (decision: Decision, anchorId: string) => void;
  /** The questions this search shows, in order, as its URL names them. */
  shownQuestionIds: readonly string[];
  /**
   * Rewrites that list from the one the URL holds when the write lands, so a
   * write that settles late (a delete) cannot restore an id dropped meanwhile.
   */
  onShownQuestionIdsChange: (
    update: (shownIds: readonly string[]) => string[] | undefined,
  ) => void;
};

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
  surface: QuestionColumnSurface;
  /** The question the composer is reworking, or that it is writing a new one. */
  editing: QuestionColumn | null;
  onEditingChange: (column: QuestionColumn | null) => void;
  pendingRun: PendingRun | null;
  onCancelRun: () => void;
  onConfirmRun: () => void;
  /** Asks every question this search shows of every row that lacks an answer. */
  onRunAll: () => void;
  removing: QuestionColumn | null;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
};

export const useQuestionColumns = ({
  enabled,
  onShowPassage,
  onShownQuestionIdsChange,
  pageDecisionIds,
  search,
  selectedDecisionIds,
  shownQuestionIds,
}: QuestionColumnsInput): QuestionColumnsController => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const authStatus = useClientAuthStatus();
  const activeOrganizationId = authStatus.isAuthenticated
    ? authStatus.user.activeOrganizationId
    : null;
  // One question per action, because the organization grants them separately:
  // a reader may be licensed to write a question and not to pay for answering
  // it. `usePermissions` fails closed while the role cache is cold.
  const grants = {
    create: usePermissions({ caseLawResearch: ["create"] }),
    update: usePermissions({ caseLawResearch: ["update"] }),
    delete: usePermissions({ caseLawResearch: ["delete"] }),
    run: usePermissions({ caseLawResearch: ["run"] }),
  } satisfies QuestionColumnGrants;

  const [editing, setEditing] = useState<QuestionColumn | null>(null);
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

  // Only what this search shows is drawn, run and searched; the rest of the
  // organization's questions are offered for adding.
  const { shown, addable } = questionsOnSearch({
    library: columns ?? NO_QUESTION_COLUMNS,
    shownIds: shownQuestionIds,
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

  const remove = useMutation({
    mutationFn: async (columnId: string) =>
      await deleteQuestionColumn(columnId),
    onSuccess: async (_deleted, columnId) => {
      setRemoving(null);
      onShownQuestionIdsChange((shownIds) =>
        withoutQuestionOnSearch(shownIds, columnId),
      );
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
      columns: shown,
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
        setEditing(column);
        break;
      case "remove":
        onShownQuestionIdsChange((shownIds) =>
          withoutQuestionOnSearch(shownIds, column.id),
        );
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
    surface: questionColumnSurface({
      // The same two answers that gated the reads above gate the controls: a
      // surface that asks nothing draws no rail, so nothing reads the
      // organization's columns to decide whether the rail is at its cap.
      activeOrganizationId,
      enabled,
      answersByKey,
      columns: shown,
      addable,
      onAddToSearch: (columnIds) => {
        onShownQuestionIdsChange((shownIds) =>
          withQuestionsOnSearch(shownIds, columnIds),
        );
      },
      grants,
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
      onShowPassage,
      suggestion: { ...search, decisionIds: pageDecisionIds },
    }),
    editing,
    onEditingChange: setEditing,
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
 * and the dialogs those flows and the column headers share.
 *
 * A surface with nothing to ask of draws nothing; a reader without an
 * organization gets the add-question trigger alone, because there is no column
 * of theirs to answer or edit yet.
 */
export const QuestionColumnControls = ({
  controller,
}: {
  controller: QuestionColumnsController;
}) => {
  const t = useTranslations();
  const { editing, pendingRun, removing, surface } = controller;

  if (surface.type !== "available") {
    return <AddQuestionColumn surface={surface} triggerVariant="labelled" />;
  }

  return (
    <>
      <AddQuestionColumn surface={surface} triggerVariant="labelled" />
      {surface.grants.run && surface.columns.length > 0 && (
        <Button
          className="text-muted-foreground h-7 min-h-0"
          disabled={surface.isRunning}
          onClick={controller.onRunAll}
          size="sm"
          variant="ghost"
        >
          {t("caseLaw.research.runAll")}
        </Button>
      )}

      {editing !== null && (
        <BulkAddColumns
          // A new dialog per question, so the fields start from what is being
          // edited rather than from whatever was typed last.
          key={editing.id}
          onOpenChange={(open) => {
            if (!open) {
              controller.onEditingChange(null);
            }
          }}
          open
          target={{
            kind: "organisation",
            editing,
            suggestion: surface.suggestion,
          }}
          triggerVariant="none"
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
              {t("workspaces.properties.deleteProperty")}
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
