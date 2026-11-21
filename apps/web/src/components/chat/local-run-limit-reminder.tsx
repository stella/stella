import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  CHAT_LIMIT_RESET_ACTION,
  type ChatLimitResetAction,
} from "@stll/api-contract/chat-limit-reminder";
import { Button } from "@stll/ui/button";

import {
  cancelChatLimitReminder,
  chatLimitReminderOptions,
  setChatLimitReminder,
} from "@/features/chat/chat-limit-reminder";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { useQueryViewError } from "@/lib/use-query-view";
import { resourceMutation } from "@/lib/workspace-realtime";

/** What an armed request says will happen at the reset, by its action. */
const SCHEDULED_KEYS = {
  continue: "chat.localRun.limitResumeScheduled",
  notify: "chat.localRun.limitReminderScheduled",
} as const satisfies Record<ChatLimitResetAction, TranslationKey>;

/** What the member asks for on the stopped turn, or that they cancel it. */
type LimitReminderChange =
  { type: "set"; onReset: ChatLimitResetAction } | { type: "cancel" };

/**
 * Under a turn stopped by the usage limit of the agent on the member's
 * computer: have the chat continue by itself once the limit resets, or only
 * be told then (in the app and on the phone), or cancel either. The reset
 * time comes from the server, which reads it off the stopped turn.
 */
export const LocalRunLimitReminder = ({
  disabled,
  threadRef,
}: {
  disabled: boolean;
  threadRef: ChatThreadRef;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const queryClient = useQueryClient();
  const options = chatLimitReminderOptions({
    activeOrganizationId,
    threadRef,
    userId,
  });
  const reminder = queryView(useQuery(options));
  useQueryViewError(reminder, "LocalRunLimitReminder:query");
  const saveReminder = resourceMutation({
    mutation: "changeChatLimitReminder",
    queryClient,
    scope: { type: "organization" },
    mutationFn: async (next: LimitReminderChange) =>
      next.type === "set"
        ? await setChatLimitReminder(threadRef, next.onReset)
        : await cancelChatLimitReminder(threadRef),
  });
  const change = useMutation({
    mutationFn: saveReminder,
    onSuccess: (data) => {
      queryClient.setQueryData(options.queryKey, data);
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
  // Until it loads, or when it cannot be read, the turn's own message and
  // its resend action are enough; the reminder is an extra.
  if (reminder.type !== "items") {
    return null;
  }
  const busy = disabled || change.isPending;
  const asked = reminder.items;
  if (asked.remindAt === null) {
    return (
      <>
        <Button
          disabled={busy}
          disabledReason={
            change.isPending
              ? t("common.saving")
              : t("chat.answerEdit.waitForAnswer")
          }
          onClick={() => {
            change.mutate({
              type: "set",
              onReset: CHAT_LIMIT_RESET_ACTION.continue,
            });
          }}
          size="sm"
          variant="destructive-outline"
        >
          {t("chat.localRun.limitResumeContinue")}
        </Button>
        <Button
          disabled={busy}
          disabledReason={
            change.isPending
              ? t("common.saving")
              : t("chat.answerEdit.waitForAnswer")
          }
          onClick={() => {
            change.mutate({
              type: "set",
              onReset: CHAT_LIMIT_RESET_ACTION.notify,
            });
          }}
          size="sm"
          variant="destructive-outline"
        >
          {t("chat.localRun.limitReminderNotify")}
        </Button>
      </>
    );
  }
  const time = format.dateTime(
    new Date(asked.remindAt),
    MEDIUM_DATE_SHORT_TIME_FORMAT,
  );
  return (
    <>
      <p className="text-sm">{t(SCHEDULED_KEYS[asked.onReset], { time })}</p>
      <Button
        disabled={busy}
        disabledReason={
          change.isPending
            ? t("common.saving")
            : t("chat.answerEdit.waitForAnswer")
        }
        onClick={() => {
          change.mutate({ type: "cancel" });
        }}
        size="sm"
        variant="destructive-outline"
      >
        {t("common.cancel")}
      </Button>
    </>
  );
};
