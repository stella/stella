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
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            aria-label={t("chat.answerEdit.history")}
          />
        }
      >
        {t("workspaces.overview.edited")}
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
  useQueryViewError(view);
  const restore = async (toRevision: number) => {
    if (
      disabled ||
      onAnswerEdited === undefined ||
      writeState.status !== "idle"
    ) {
      return;
    }
    setWriteState({ status: "saving" });
    const result = await Result.tryPromise({
      try: async () => {
        unwrapEden(
          await api.chat
            .threads({ threadId })
            .messages({ messageId })
            .revisions({ revision: toRevision })
            .revert.post({ baseRevision: revision }),
        );
        await onAnswerEdited(messageId);
        await query.refetch();
      },
      catch: (error) => error,
    });
    if (Result.isOk(result)) {
      setWriteState({ status: "idle" });
      setSelectedRevision(null);
      return;
    }
    getAnalytics().captureError(result.error);
    if (APIError.is(result.error) && result.error.status === 409) {
      setWriteState({ status: "stale" });
      const refresh = await Result.tryPromise({
        try: () => onAnswerEdited(messageId),
        catch: (error) => error,
      });
      if (Result.isError(refresh)) {
        getAnalytics().captureError(refresh.error);
      }
      return;
    }
    setWriteState({ status: "error" });
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
                            revision: row.revision + 1,
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
                                writeState.status !== "idle"
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
  | { status: "error" };

const ANSWER_EDIT_KIND_KEYS = {
  [CHAT_MESSAGE_EDIT_TYPE.aiSpan]: "chat.answerEdit.aiKind",
  [CHAT_MESSAGE_EDIT_TYPE.format]: "chat.answerEdit.formatKind",
  [CHAT_MESSAGE_EDIT_TYPE.revert]: "chat.answerEdit.revertKind",
} as const satisfies Record<ChatMessageRevisionEdit["type"], TranslationKey>;
