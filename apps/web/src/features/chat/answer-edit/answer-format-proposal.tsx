import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

import type { AnswerEditProposal } from "./answer-edit-api";
import { AnswerEditPanel, AnswerEditNotice } from "./answer-edit-panel";
import type { AnswerFormatPanelProps } from "./answer-format-panel";
import { formatAnswerSpan } from "./markdown-format.logic";
import type { AnswerFormatAction } from "./markdown-format.logic";

export const AnswerFormatProposal = ({
  anchor,
  selection,
  action,
  threadId,
  disabled,
  onCancel,
  onAnswerEdited,
}: Omit<AnswerFormatPanelProps, "entry"> & { action: AnswerFormatAction }) => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const [refreshError, setRefreshError] = useState(false);
  const cancelStale = () =>
    detached(
      (async () => {
        const refreshed = await Result.tryPromise({
          try: onAnswerEdited,
          catch: (error) => error,
        });
        if (Result.isError(refreshed)) {
          getAnalytics().captureError(refreshed.error);
          setRefreshError(true);
          return;
        }
        onCancel();
      })(),
      "answer-format.refresh",
    );
  const staleNotice = (
    <div
      role="dialog"
      aria-label={t("chat.answerEdit.textStyle")}
      tabIndex={-1}
      ref={(node) => {
        if (node === null) {
          return undefined;
        }
        node.focus();
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key !== "Escape") {
            return;
          }
          event.preventDefault();
          cancelStale();
        };
        node.addEventListener("keydown", onKeyDown);
        return () => node.removeEventListener("keydown", onKeyDown);
      }}
    >
      <AnswerEditNotice status="stale" onCancel={cancelStale} />
    </div>
  );
  const focusCancelablePanel = (node: HTMLDivElement | null) => {
    if (node === null) {
      return undefined;
    }
    node.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      onCancel();
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  };
  const result = formatAnswerSpan({
    source: selection.source,
    start: selection.start,
    end: selection.end,
    action,
  });
  const query = useQuery({
    queryKey: chatKeys.answerSnapshot({
      activeOrganizationId: user.activeOrganizationId,
      userId: user.id,
      threadId,
      messageId: anchor.messageId,
      revision: anchor.baseRevision,
    }),
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api.chat
          .threads({ threadId })
          .messages({ messageId: anchor.messageId })
          .get({ fetch: { signal } }),
      ),
    enabled: result.status === "proposal",
    retry: false,
  });
  const view = useQueryView(query);
  useQueryViewError(view);
  if (refreshError) {
    return (
      <div
        className="w-80 p-2"
        ref={focusCancelablePanel}
        role="dialog"
        aria-label={t("chat.answerEdit.textStyle")}
        tabIndex={-1}
      >
        <p role="alert">{t("errors.actionFailed")}</p>
        <Button size="sm" onClick={cancelStale}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  if (result.status === "unchanged") {
    return null;
  }
  if (result.status === "unsupported") {
    return (
      <div
        className="w-80 space-y-2 p-2"
        ref={focusCancelablePanel}
        role="dialog"
        aria-label={t("chat.answerEdit.textStyle")}
        tabIndex={-1}
      >
        <p role="alert">
          {t(
            result.reason === "whole-block-required"
              ? "chat.answerEdit.wholeBlockRequired"
              : "chat.answerEdit.invalidSelection",
          )}
        </p>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    );
  }
  switch (view.type) {
    case "pending":
      return (
        <div
          className="w-80 p-2"
          ref={focusCancelablePanel}
          role="dialog"
          aria-label={t("chat.answerEdit.textStyle")}
          tabIndex={-1}
        >
          <p role="status">{t("common.loading")}</p>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      );
    case "error":
      return (
        <div
          className="w-80 space-y-2 p-2"
          ref={focusCancelablePanel}
          role="dialog"
          aria-label={t("chat.answerEdit.textStyle")}
          tabIndex={-1}
        >
          <p role="alert">{t("errors.actionFailed")}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => detached(query.refetch(), "answer-format.retry")}
          >
            {t("common.retry")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      );
    case "empty":
      return staleNotice;
    case "items": {
      const snapshot = view.items;
      if (snapshot.revision !== anchor.baseRevision) {
        return staleNotice;
      }
      const textPart = snapshot.content.data.at(selection.partIndex);
      if (
        typeof textPart !== "object" ||
        textPart === null ||
        !("type" in textPart) ||
        textPart.type !== "text" ||
        !("content" in textPart) ||
        textPart.content !== selection.source
      ) {
        return staleNotice;
      }
      const start = selection.partOffset + result.start;
      const end = selection.partOffset + result.end;
      const proposal = {
        content: {
          version: 3,
          data: snapshot.content.data.map((part, index) =>
            index === selection.partIndex
              ? {
                  ...textPart,
                  content:
                    selection.source.slice(0, result.start) +
                    result.replacement +
                    selection.source.slice(result.end),
                }
              : part,
          ),
          ...(snapshot.content.metadata === undefined
            ? {}
            : { metadata: snapshot.content.metadata }),
        },
        replacement: result.replacement,
        edit: { ...result.edit, start, end },
      } satisfies AnswerEditProposal;
      return (
        <AnswerEditPanel
          anchor={{
            messageId: anchor.messageId,
            baseRevision: anchor.baseRevision,
            start,
            end,
            selectedSource: result.selectedSource,
          }}
          threadId={threadId}
          disabled={disabled}
          onCancel={onCancel}
          onAnswerEdited={onAnswerEdited}
          initialProposal={proposal}
        />
      );
    }
    default:
      view satisfies never;
      return panic("Unhandled answer snapshot");
  }
};
