import { useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { CHAT_MESSAGE_EDIT_TYPE } from "@stll/api-contract/chat-message-revisions";
import type { ChatMessageRevisionEdit } from "@stll/api-contract/chat-message-revisions";
import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ReviewDiffText } from "@stll/ui/review-diff-text";
import { ScrollArea } from "@stll/ui/scroll-area";

import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

import { answerRevisionHistoryOptions } from "./answer-edit-queries";

export const AnswerRevisionHistory = ({
  threadId,
  messageId,
  revision,
  disabled,
  onAnswerEdited,
}: AnswerRevisionHistoryProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="ghost" />}>
        {t("chat.answerEdit.editedLabel")}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[min(28rem,calc(100vw-2rem))]">
        <AnswerRevisionHistoryContent
          key={revision}
          threadId={threadId}
          messageId={messageId}
          revision={revision}
          disabled={disabled}
          onAnswerEdited={onAnswerEdited}
          enabled={open}
        />
      </PopoverPopup>
    </Popover>
  );
};

type AnswerRevisionHistoryProps = {
  threadId: string;
  messageId: string;
  revision: number;
  disabled: boolean;
  onAnswerEdited?: ((messageId: string) => Promise<void>) | undefined;
};

export const AnswerRevisionHistoryContent = ({
  threadId,
  messageId,
  revision,
  disabled,
  onAnswerEdited,
  enabled = true,
}: AnswerRevisionHistoryProps & { enabled?: boolean }) => {
  const t = useTranslations();
  const format = useFormatter();
  const user = useAuthenticatedUser();
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [writeState, setWriteState] = useState<HistoryWriteState>({
    status: "idle",
  });
  const query = useInfiniteQuery({
    ...answerRevisionHistoryOptions({
      activeOrganizationId: user.activeOrganizationId,
      userId: user.id,
      threadId,
      messageId,
      revision,
    }),
    enabled,
  });
  const view = useQueryView(query);
  useQueryViewError(view, "AnswerRevisionHistory:query");
  const writeBlocked = !(
    writeState.status === "idle" ||
    (writeState.status === "awaiting-revision" &&
      revision >= writeState.revision)
  );
  const restore = async (toRevision: number) => {
    if (disabled || onAnswerEdited === undefined || writeBlocked) {
      return;
    }
    setWriteState({ status: "saving" });
    const saved = await Result.tryPromise({
      try: async () =>
        unwrapEden(
          await api.chat
            .threads({ threadId })
            .messages({ messageId })
            .revisions({ revision: toRevision })
            .revert.post({ baseRevision: revision }),
        ),
      catch: (error) => error,
    });
    if (Result.isOk(saved)) {
      setSelectedRevision(null);
      await refreshAfterRestore(saved.value.revision);
      return;
    }
    getAnalytics().captureError(saved.error, {
      fingerprintKey: "AnswerRevisionHistory.restore:failure",
      scope: {
        type: "handler",
        handlerId: "AnswerRevisionHistory.restore:failure",
      },
    });
    if (APIError.is(saved.error) && saved.error.status === 409) {
      setWriteState({ status: "stale" });
      const refresh = await Result.tryPromise({
        try: async () => onAnswerEdited(messageId),
        catch: (error) => error,
      });
      if (Result.isError(refresh)) {
        getAnalytics().captureError(refresh.error, {
          fingerprintKey: "AnswerRevisionHistory.refreshStale:failure",
          scope: {
            type: "handler",
            handlerId: "AnswerRevisionHistory.refreshStale:failure",
          },
        });
      }
      return;
    }
    setWriteState({ status: "error" });
  };
  const refreshAfterRestore = async (restoredRevision: number) => {
    setWriteState({ status: "refreshing", revision: restoredRevision });
    const refetched = await Result.tryPromise({
      try: async () => {
        await onAnswerEdited?.(messageId);
        return query.refetch();
      },
      catch: (error) => error,
    });
    const refreshed = refetched.andThen((history) =>
      history.isError ? Result.err(history.error) : Result.ok(history),
    );
    if (Result.isError(refreshed)) {
      getAnalytics().captureError(refreshed.error, {
        fingerprintKey: "AnswerRevisionHistory.refreshAfterRestore:failure",
        scope: {
          type: "handler",
          handlerId: "AnswerRevisionHistory.refreshAfterRestore:failure",
        },
      });
      setWriteState({ status: "refresh-error", revision: restoredRevision });
      return;
    }
    setWriteState({ status: "awaiting-revision", revision: restoredRevision });
  };
  return (
    <div className="min-w-0 space-y-3">
      <h2 className="text-sm font-medium">{t("chat.answerEdit.history")}</h2>
      {writeState.status === "stale" && (
        <p role="alert">{t("chat.answerEdit.stale")}</p>
      )}
      {writeState.status === "error" && (
        <div>
          <p role="alert">{t("chat.answerEdit.acceptFailed")}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setWriteState({ status: "idle" })}
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {writeState.status === "refresh-error" && (
        <div>
          <p role="alert">{t("chat.answerEdit.restoreRefreshFailed")}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              detached(
                refreshAfterRestore(writeState.revision),
                "answer-history.refresh-after-restore",
              )
            }
          >
            {t("common.refresh")}
          </Button>
        </div>
      )}
      {writeState.status === "refreshing" && (
        <p role="status">{t("common.loading")}</p>
      )}
      {(() => {
        switch (view.type) {
          case "pending":
            return <p role="status">{t("common.loading")}</p>;
          case "error":
            return (
              <div>
                <p role="alert">{t("errors.actionFailed")}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    detached(query.refetch(), "answer-history.retry")
                  }
                >
                  {t("common.retry")}
                </Button>
              </div>
            );
          case "empty":
            return <p>{t("chat.answerEdit.historyEmpty")}</p>;
          case "items": {
            const rows = view.items.pages.flatMap((page) => page.items);
            if (rows.length === 0) {
              return <p>{t("chat.answerEdit.historyEmpty")}</p>;
            }
            return (
              <>
                <ScrollArea className="max-h-96">
                  <div className="space-y-3">
                    {rows.map((row) => (
                      <div
                        key={row.id}
                        className="space-y-2 border-b pb-3 last:border-b-0"
                      >
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setSelectedRevision(
                              selectedRevision === row.revision
                                ? null
                                : row.revision,
                            )
                          }
                          aria-expanded={selectedRevision === row.revision}
                        >
                          {t("chat.answerEdit.change", {
                            revision: String(row.revision + 1),
                          })}
                        </Button>
                        <p className="text-muted-foreground text-xs">
                          <bdi>
                            {row.actorName ??
                              t("chat.answerEdit.authorUnknown")}
                          </bdi>
                          {" · "}
                          {format.dateTime(
                            new Date(row.createdAt),
                            MEDIUM_DATE_SHORT_TIME_FORMAT,
                          )}
                          {" · "}
                          {t(ANSWER_EDIT_KIND_KEYS[row.edit.type])}
                        </p>
                        {selectedRevision === row.revision && (
                          <>
                            <ReviewDiffText
                              className="wrap-break-word whitespace-pre-wrap"
                              segments={[
                                { type: "delete", text: row.beforeText },
                                { type: "insert", text: row.afterText },
                              ]}
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                disabled ||
                                onAnswerEdited === undefined ||
                                writeBlocked
                              }
                              onClick={() =>
                                detached(
                                  restore(row.revision),
                                  "answer-history.restore",
                                )
                              }
                            >
                              {t("clauses.restoreVersion")}
                            </Button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
                {query.hasNextPage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={query.isFetchingNextPage}
                    onClick={() =>
                      detached(query.fetchNextPage(), "answer-history.more")
                    }
                  >
                    {t("common.loadMore")}
                  </Button>
                )}
              </>
            );
          }
          default:
            view satisfies never;
            return panic("Unhandled answer history");
        }
      })()}
    </div>
  );
};

type HistoryWriteState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "stale" }
  | { status: "error" }
  | { status: "refreshing"; revision: number }
  | { status: "refresh-error"; revision: number }
  | { status: "awaiting-revision"; revision: number };

const ANSWER_EDIT_KIND_KEYS = {
  [CHAT_MESSAGE_EDIT_TYPE.aiSpan]: "chat.answerEdit.aiKind",
  [CHAT_MESSAGE_EDIT_TYPE.format]: "chat.answerEdit.formatKind",
  [CHAT_MESSAGE_EDIT_TYPE.revert]: "chat.answerEdit.revertKind",
} as const satisfies Record<ChatMessageRevisionEdit["type"], TranslationKey>;
