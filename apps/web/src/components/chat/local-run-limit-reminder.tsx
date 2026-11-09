import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import {
  cancelChatLimitReminder,
  chatLimitReminderOptions,
  setChatLimitReminder,
} from "@/features/chat/chat-limit-reminder";
import { useFormatter } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { useQueryViewError } from "@/lib/use-query-view";

/**
 * Under a turn stopped by the usage limit of the agent on the member's
 * computer: ask to be told (in the app and on the phone) once the limit
 * resets, or cancel that. The reset time comes from the server, which reads
 * it off the stopped turn.
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
  const change = useMutation({
    mutationFn: async (next: "set" | "cancel") =>
      next === "set"
        ? await setChatLimitReminder(threadRef)
        : await cancelChatLimitReminder(threadRef),
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
  const { remindAt } = reminder.items;
  if (remindAt === null) {
    return (
      <Button
        disabled={busy}
        onClick={() => {
          change.mutate("set");
        }}
        size="sm"
        variant="destructive-outline"
      >
        {t("chat.localRun.limitReminderNotify")}
      </Button>
    );
  }
  return (
    <>
      <p className="text-sm">
        {t("chat.localRun.limitReminderScheduled", {
          time: format.dateTime(
            new Date(remindAt),
            MEDIUM_DATE_SHORT_TIME_FORMAT,
          ),
        })}
      </p>
      <Button
        disabled={busy}
        onClick={() => {
          change.mutate("cancel");
        }}
        size="sm"
        variant="destructive-outline"
      >
        {t("common.cancel")}
      </Button>
    </>
  );
};
