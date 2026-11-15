import { panic } from "better-result";
import { Pressable, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import {
  CHAT_THREAD_PIN_STATE,
  CHAT_THREAD_READ_STATE,
} from "@stll/api-contract/chat";
import type {
  ChatActiveRunState,
  ChatThreadPinState,
  ChatThreadReadState,
} from "@stll/api-contract/chat";
import { MatterIcon } from "@stll/ui/matter-icon";
import { RunStateMark } from "@stll/ui/run-state-mark";
import { Text } from "@stll/ui/text";

import { useOpenThread } from "@/components/open-thread";
import { useLayout, useSelection } from "@/components/selection";
import { SwipeRow } from "@/components/swipe-row";
import type { SwipeAccessibility, SwipeActions } from "@/components/swipe-row";
import { useOptimisticWrite } from "@/components/use-optimistic-write";
import { WriteFailureNotice } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { CheckCheckIcon, MailIcon, PinIcon, PinOffIcon } from "@/icons.gen";
import type { InboxThread } from "@/state/chat-runs";
import {
  setChatThreadPinState,
  setChatThreadReadState,
} from "@/state/chat-threads";
import type { ChatThreadSummary } from "@/state/chat-threads";

/**
 * One thread: its title, then the matter it belongs to. Today's and
 * yesterday's threads show the time, older ones the date. A thread with an
 * unfinished run shows its mark before the time; the section it heads names
 * the state. A thread with an answer the reader has not read shows a dot
 * before its title. Tapping it opens the thread, beside the list where the
 * window has two columns, which marks it as the one open. Swiping it
 * towards its trailing edge marks it read or unread, as Mail's rows do; the
 * other way pins or unpins it. A thread only an open run names, older than
 * the threads loaded so far, has no marks the list read, so it offers none.
 */
export const ChatThreadRow = ({
  row,
  source,
}: {
  row: InboxThread;
  source: AccessTokenSource;
}) => {
  switch (row.type) {
    case "listed":
      return (
        <MarkableRow
          day={row.day}
          runState={row.runState}
          source={source}
          thread={row.thread}
        />
      );
    case "run-only":
      return (
        <ThreadPressable
          accessibility={undefined}
          day={row.day}
          runState={row.runState}
          thread={row.thread}
          readState={undefined}
        />
      );
    default:
      row satisfies never;
      return panic("unknown chats list row");
  }
};

const MarkableRow = ({
  day,
  runState,
  source,
  thread,
}: {
  day: InboxThread["day"];
  runState: ChatActiveRunState | undefined;
  source: AccessTokenSource;
  thread: ChatThreadSummary;
}) => {
  const t = useTranslations("chat");
  // Each mark holds over the load the thread came from; the list loads
  // again once one saves, and then shows what the server says.
  const read = useOptimisticWrite({
    from: thread,
    kind: "chats",
    reported: thread.readState,
    source,
  });
  const pin = useOptimisticWrite({
    from: thread,
    kind: "chats",
    reported: thread.pinState,
    source,
  });
  const scope = {
    fetch,
    matterId: thread.matterId,
    source,
    threadId: thread.id,
  };
  const nextRead = otherReadState(read.value);
  const nextPin = otherPinState(pin.value);
  const actions: SwipeActions = {
    leading: read.saving
      ? null
      : {
          icon:
            nextRead === CHAT_THREAD_READ_STATE.read
              ? CheckCheckIcon
              : MailIcon,
          label: t(
            nextRead === CHAT_THREAD_READ_STATE.read
              ? "markRead"
              : "markUnread",
          ),
          name: "changeReadState",
          run: () => {
            read.write(
              nextRead,
              async () =>
                await setChatThreadReadState({ ...scope, readState: nextRead }),
            );
          },
        },
    trailing: pin.saving
      ? null
      : {
          icon: nextPin === CHAT_THREAD_PIN_STATE.pinned ? PinIcon : PinOffIcon,
          label: t(nextPin === CHAT_THREAD_PIN_STATE.pinned ? "pin" : "unpin"),
          name: "changePinState",
          run: () => {
            pin.write(
              nextPin,
              async () =>
                await setChatThreadPinState({ ...scope, pinState: nextPin }),
            );
          },
        },
  };

  return (
    <SwipeRow actions={actions}>
      {(accessibility) => (
        <ThreadPressable
          accessibility={accessibility}
          day={day}
          runState={runState}
          thread={thread}
          readState={read.value}
        >
          {/* A mark that did not save shows the state from before it again,
              so the other state is the one the reader tried. */}
          <WriteFailureNotice
            failure={read.failure}
            message={t(
              nextRead === CHAT_THREAD_READ_STATE.read
                ? "markReadFailed"
                : "markUnreadFailed",
            )}
          />
          <WriteFailureNotice
            failure={pin.failure}
            message={t(
              nextPin === CHAT_THREAD_PIN_STATE.pinned
                ? "pinFailed"
                : "unpinFailed",
            )}
          />
        </ThreadPressable>
      )}
    </SwipeRow>
  );
};

const otherReadState = (state: ChatThreadReadState): ChatThreadReadState => {
  switch (state) {
    case CHAT_THREAD_READ_STATE.read:
      return CHAT_THREAD_READ_STATE.unread;
    case CHAT_THREAD_READ_STATE.unread:
      return CHAT_THREAD_READ_STATE.read;
    default:
      state satisfies never;
      return panic("unknown chat read state");
  }
};

const otherPinState = (state: ChatThreadPinState): ChatThreadPinState => {
  switch (state) {
    case CHAT_THREAD_PIN_STATE.pinned:
      return CHAT_THREAD_PIN_STATE.unpinned;
    case CHAT_THREAD_PIN_STATE.unpinned:
      return CHAT_THREAD_PIN_STATE.pinned;
    default:
      state satisfies never;
      return panic("unknown chat pin state");
  }
};

const ThreadPressable = ({
  accessibility,
  children,
  day,
  runState,
  thread,
  readState,
}: React.PropsWithChildren<{
  /** What the swipe offers a screen reader, when the row swipes. */
  accessibility: SwipeAccessibility | undefined;
  /** The day heading the thread's last activity falls under. */
  day: InboxThread["day"];
  runState: ChatActiveRunState | undefined;
  thread: InboxThread["thread"];
  /** How the reader marked the thread; unknown for one the list did not read. */
  readState: ChatThreadReadState | undefined;
}>) => {
  const unread = readState === CHAT_THREAD_READ_STATE.unread;
  const format = useFormatter();
  const t = useTranslations("chat");
  const updatedAt = new Date(thread.updatedAt);
  const when =
    day === "today" || day === "yesterday"
      ? format.dateTime(updatedAt, { hour: "numeric", minute: "2-digit" })
      : format.dateTime(updatedAt, { day: "numeric", month: "short" });
  const title = thread.title.trim() === "" ? t("untitled") : thread.title;
  const openThread = useOpenThread();
  const layout = useLayout();
  const selection = useSelection();
  const open = layout.usesSplitView && selection.thread?.threadId === thread.id;

  return (
    <Pressable
      {...accessibility}
      accessibilityRole="button"
      accessibilityState={{ selected: open }}
      // Said after the title, so the dot is not the only sign of it.
      accessibilityValue={unread ? { text: t("unread") } : undefined}
      className={`border-border active:bg-accent gap-0.5 border-b py-3 ${open ? "bg-accent" : ""}`}
      onPress={() => {
        openThread({ matterId: thread.matterId, threadId: thread.id, title });
      }}
    >
      <View className="flex-row items-start gap-3">
        <View className="flex-1 flex-row items-center gap-1.5">
          {unread ? <View className="bg-info size-2 rounded-full" /> : null}
          <View className="flex-1">
            <Text numberOfLines={2} variant="rowTitle">
              {title}
            </Text>
          </View>
        </View>
        <View className="flex-row items-center gap-1.5">
          {runState === undefined ? null : <RunStateMark state={runState} />}
          <Text variant="caption">{when}</Text>
        </View>
      </View>
      {thread.matterName === undefined ||
      thread.matterId === undefined ? null : (
        <View className="flex-row items-center gap-1.5">
          <MatterIcon matter={{ id: thread.matterId }} size={12} />
          <View className="flex-1">
            <Text numberOfLines={1} variant="caption">
              {thread.matterName}
            </Text>
          </View>
        </View>
      )}
      {children}
    </Pressable>
  );
};
