import { Suspense, use, useState, useTransition } from "react";
import type { ContextType } from "react";

import { Result } from "better-result";
import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import {
  CHAT_LIMIT_RESET_ACTION,
  type ChatLimitResetAction,
} from "@stll/api-contract/chat-limit-reminder";
import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { ThreadMatter } from "@/components/thread-matter";
import { ThreadSteps } from "@/components/thread-steps";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import {
  cancelChatLimitReminder,
  type ChatLimitReminder,
  readChatLimitReminder,
  setChatLimitReminder,
} from "@/state/chat-limit-reminder";

/** The reset time as the web shows it: the day and the minute. */
const RESET_TIME_FORMAT = {
  dateStyle: "medium",
  timeStyle: "short",
} as const satisfies Intl.DateTimeFormatOptions;

/** What an armed request says will happen at the reset, by its action. */
const SCHEDULED_KEYS = {
  continue: "limitResumeScheduled",
  notify: "limitReminderScheduled",
} as const satisfies Record<ChatLimitResetAction, string>;

/** The stored request, and why the last change of it did not save. */
type ReminderState = {
  readonly reminder: Result<ChatLimitReminder, ApiError>;
  readonly failure: WriteFailure | null;
};

/**
 * Why a coding agent on the person's computer stopped: its usage limit, and
 * when it resets, in the person's own locale and time zone.
 */
export const LimitResetMessage = ({ resetsAt }: { resetsAt: string }) => {
  const t = useTranslations("chat.localRun");
  const format = useFormatter();
  return (
    <Text variant="error">
      {t("errorLimitResetsAt", {
        time: format.dateTime(new Date(resetsAt), RESET_TIME_FORMAT),
      })}
    </Text>
  );
};

/**
 * Under the thread's latest answer, stopped by that limit: have the chat
 * continue by itself once the limit resets, or only be told then, or cancel
 * either; as the web offers it. The server reads the time off the stopped
 * turn. Outside a thread (nothing to ask the server about) it shows nothing.
 */
export const LimitResetChoice = () => {
  const thread = use(ThreadSteps);
  return thread === undefined ? null : (
    <ThreadLimitResetChoice thread={thread} />
  );
};

const ThreadLimitResetChoice = ({
  thread,
}: {
  thread: NonNullable<ContextType<typeof ThreadSteps>>;
}) => {
  const matterId = use(ThreadMatter);
  const { end } = useSession();
  const request = { fetch, matterId, ...thread };
  const settle = async (
    write: Promise<Result<ChatLimitReminder, ApiError>>,
    previous: Result<ChatLimitReminder, ApiError> | null,
  ): Promise<ReminderState> => {
    const reminder = await write;
    if (Result.isError(reminder)) {
      if (reminder.error._tag === "SignedOutError") {
        end(thread.source);
      }
      // A change that did not save leaves what the server stores as it was.
      return previous === null
        ? { reminder, failure: null }
        : { reminder: previous, failure: writeFailure(reminder.error) };
    }
    return { reminder, failure: null };
  };
  const [load, setLoad] = useState(
    async () => await settle(readChatLimitReminder(request), null),
  );
  return (
    <Suspense fallback={null}>
      <LoadedChoice
        load={load}
        onChange={(next, previous) => {
          setLoad(
            settle(
              next.type === "set"
                ? setChatLimitReminder({ ...request, onReset: next.onReset })
                : cancelChatLimitReminder(request),
              previous,
            ),
          );
        }}
      />
    </Suspense>
  );
};

type ReminderChange =
  | { readonly type: "set"; readonly onReset: ChatLimitResetAction }
  | { readonly type: "cancel" };

const LoadedChoice = ({
  load,
  onChange,
}: {
  load: Promise<ReminderState>;
  onChange: (
    next: ReminderChange,
    previous: Result<ChatLimitReminder, ApiError>,
  ) => void;
}) => {
  const t = useTranslations("chat.localRun");
  const chat = useTranslations("chat");
  const format = useFormatter();
  const [changing, startChange] = useTransition();
  const { failure, reminder } = use(load);
  // Until it loads, or when it cannot be read, the failure and its resend
  // are enough; the choice is an extra.
  if (Result.isError(reminder)) {
    return null;
  }
  const apply = (next: ReminderChange) => {
    startChange(() => {
      onChange(next, reminder);
    });
  };
  const asked = reminder.value;
  return (
    <View className="items-start gap-2">
      {asked.remindAt === null ? (
        <>
          <Button
            disabled={changing}
            onPress={() => {
              apply({ type: "set", onReset: CHAT_LIMIT_RESET_ACTION.continue });
            }}
            variant="outline"
          >
            {t("limitResumeContinue")}
          </Button>
          <Button
            disabled={changing}
            onPress={() => {
              apply({ type: "set", onReset: CHAT_LIMIT_RESET_ACTION.notify });
            }}
            variant="outline"
          >
            {t("limitReminderNotify")}
          </Button>
        </>
      ) : (
        <>
          <Text>
            {t(SCHEDULED_KEYS[asked.onReset], {
              time: format.dateTime(
                new Date(asked.remindAt),
                RESET_TIME_FORMAT,
              ),
            })}
          </Text>
          <Button
            disabled={changing}
            onPress={() => {
              apply({ type: "cancel" });
            }}
            variant="outline"
          >
            {t("limitReminderCancel")}
          </Button>
        </>
      )}
      <WriteFailureNotice
        failure={failure}
        message={chat("limitReminderFailed")}
      />
    </View>
  );
};
