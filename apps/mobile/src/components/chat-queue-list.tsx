import {
  Suspense,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { panic, Result } from "better-result";
import { Alert, Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import { QUEUED_MESSAGE_FILES_ON_REMOVE } from "@stll/api-contract/chat-queue";
import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { useChanged, useRevisedLoad } from "@/components/changes";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { needsConsent } from "@/state/api-request";
import type { ApiError, Load } from "@/state/api-request";
import {
  type ChatQueue,
  type ChatQueueItem,
  holdChatQueue,
  moveQueuedChatMessage,
  queuedMessageText,
  readChatQueue,
  readQueuedChatMessage,
  removeQueuedChatMessage,
  sendQueuedChatMessageNow,
  steerableQueuedText,
} from "@/state/chat-queue";

/** What the thread is doing, as Send now on a queued message reads it. */
export type QueueThreadState =
  /** No turn answers or waits: the server sends the message next. */
  | "idle"
  /** A turn answers that takes messages mid-turn: it is handed the message. */
  | "steerable"
  /** A turn answers that takes none: it is stopped, the message goes next. */
  | "working"
  /** A turn waits on the person: ending it needs a confirmation. */
  | "waiting";

type ChatQueueListProps = {
  readonly source: AccessTokenSource;
  readonly threadId: string;
  readonly thread: QueueThreadState;
  /** Hands queued message `id` whole to the turn; false when not taken. */
  readonly steerQueued: (queued: {
    readonly id: string;
    readonly revision: number;
    readonly text: string;
  }) => Promise<boolean>;
  /** Puts a queued message's text back into the composer, to edit. */
  readonly onEdit: (text: string) => void;
  /**
   * The server sent a queued message as a turn of its own while this phone
   * ran none: the thread is read again, so that turn is followed.
   */
  readonly onSentByServer: () => void;
};

/**
 * The messages a thread keeps queued on the server, above the composer,
 * with the web's actions: Send now, Edit, Move, Remove, and the queue's
 * pause or the reason it waits.
 */
export const ChatQueueList = (props: ChatQueueListProps) => {
  const { source, threadId } = props;
  const [load] = useRevisedLoad(
    async (): Promise<Load<ChatQueue>> => ({
      loadedAt: epochMilliseconds(),
      result: await readChatQueue({ fetch, source, threadId }),
    }),
    ["chatQueues"],
  );
  return (
    <Suspense fallback={null}>
      <LoadedQueue {...props} load={load} />
    </Suspense>
  );
};

/**
 * Whether queued message `id` is in the queue read now. A failed read
 * answers false: the message stays counted as the phone's own hand-off.
 */
const stillQueued = async (
  request: Parameters<typeof readChatQueue>[0],
  id: string,
): Promise<boolean> => {
  const queue = await readChatQueue(request);
  return Result.isOk(queue) && queue.value.items.some((item) => item.id === id);
};

/**
 * What a running turn is handed for `item`: its text read whole (the queue
 * shows only its beginning) at the revision read, or null when it is sent
 * next instead. Only at the revision the queue's read showed: an edit since
 * may have changed `sendMode`, which says whether it may go as typed.
 */
const steerableRead = async (
  request: Parameters<typeof readChatQueue>[0],
  item: ChatQueueItem,
): Promise<{ readonly revision: number; readonly text: string } | null> => {
  const whole = await readQueuedChatMessage({ ...request, messageId: item.id });
  if (Result.isError(whole) || whole.value.revision !== item.revision) {
    return null;
  }
  const text = steerableQueuedText({
    parts: whole.value.message.parts,
    sendMode: item.sendMode,
  });
  return text === null ? null : { revision: whole.value.revision, text };
};

const LoadedQueue = ({
  load,
  onEdit,
  onSentByServer,
  source,
  steerQueued,
  thread,
  threadId,
}: ChatQueueListProps & { readonly load: Promise<Load<ChatQueue>> }) => {
  const t = useTranslations("chat.queue");
  const tLoads = useTranslations("loads");
  const { end } = useSession();
  const changed = useChanged();
  const { result } = use(load);
  const queue = Result.isOk(result) ? result.value : null;
  const ids = queue === null ? "" : queue.items.map(({ id }) => id).join(" ");

  // Every message seen queued, and those this phone took out of the queue
  // itself: one that leaves otherwise was sent by the server.
  const seen = useRef(new Set<string>());
  const removedHere = useRef(new Set<string>());
  const sentByServer = useEffectEvent(onSentByServer);
  const idle = thread === "idle";
  // What the thread does when a Send now that was not taken goes on.
  const threadNow = useRef(thread);
  useEffect(() => {
    threadNow.current = thread;
  }, [thread]);
  // The message whose actions are shown, under it.
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    if (queue === null) {
      return;
    }
    const queued = new Set(ids === "" ? [] : ids.split(" "));
    const left = [...seen.current].filter((id) => !queued.has(id));
    for (const id of queued) {
      seen.current.add(id);
    }
    if (!idle) {
      return;
    }
    for (const id of left) {
      seen.current.delete(id);
    }
    if (left.some((id) => !removedHere.current.has(id))) {
      sentByServer();
    }
  }, [ids, idle, queue]);

  if (result.isErr()) {
    if (result.error._tag === "SignedOutError") {
      end(source);
    }
    return null;
  }
  if (queue === null || queue.items.length === 0) {
    return null;
  }

  const request = { fetch, source, threadId };
  /** Runs a write on the queue, then reads it again; false when it failed. */
  const write = async (
    run: () => Promise<Result<unknown, ApiError>>,
  ): Promise<boolean> => {
    const written = await run();
    changed("chatQueues");
    if (Result.isError(written)) {
      const { error } = written;
      if (error._tag === "SignedOutError") {
        end(source);
        return false;
      }
      const status =
        error._tag === "ApiRequestError" ? error.status : undefined;
      if (needsConsent(error)) {
        Alert.alert(tLoads("consent"));
      } else if (status === 404 || status === 409) {
        // Sent, removed or edited elsewhere since this phone read it.
        Alert.alert(t("noLongerQueued"));
      } else {
        Alert.alert(
          status === undefined
            ? tLoads("offline")
            : tLoads("refused", { status }),
        );
      }
      return false;
    }
    return true;
  };

  const sendNext = (item: ChatQueueItem) => {
    void write(
      async () =>
        await sendQueuedChatMessageNow({ ...request, messageId: item.id }),
    );
  };

  /** Send now over a turn that waits on the person ends it: asked first. */
  const confirmSendNext = (item: ChatQueueItem) => {
    Alert.alert(t("replaceTitle"), t("replaceDescription"), [
      { style: "cancel", text: t("cancel") },
      {
        onPress: () => {
          sendNext(item);
        },
        style: "destructive",
        text: t("sendNow"),
      },
    ]);
  };

  const sendNow = (item: ChatQueueItem) => {
    switch (thread) {
      case "waiting":
        confirmSendNext(item);
        return;
      case "steerable":
        void (async () => {
          const handed = await steerableRead(request, item);
          removedHere.current.add(item.id);
          const steered =
            handed !== null && (await steerQueued({ id: item.id, ...handed }));
          if (steered) {
            // Taken: the server removed it at the revision the turn was
            // handed. One edited since stays queued, and when the server
            // later sends it, that is a turn this phone did not start.
            if (await stillQueued(request, item.id)) {
              removedHere.current.delete(item.id);
            }
            changed("chatQueues");
            return;
          }
          removedHere.current.delete(item.id);
          // Not taken: the turn may wait on the person by now.
          if (threadNow.current === "waiting") {
            confirmSendNext(item);
            return;
          }
          sendNext(item);
        })();
        return;
      case "idle":
      case "working":
        sendNext(item);
        return;
      default:
        thread satisfies never;
        panic("Unhandled queue thread state");
    }
  };

  const edit = (item: ChatQueueItem) => {
    void (async () => {
      const whole = await readQueuedChatMessage({
        ...request,
        messageId: item.id,
      });
      if (Result.isError(whole)) {
        // The failed read is said as a failed write is.
        await write(async () => await Promise.resolve(whole));
        return;
      }
      const text = queuedMessageText(whole.value.message.parts);
      if (text === null) {
        return;
      }
      removedHere.current.add(item.id);
      // Removed at the revision read: one edited elsewhere since stays.
      // Edit is offered for text only, so no stored file is left behind.
      const removed = await write(
        async () =>
          await removeQueuedChatMessage({
            ...request,
            files: QUEUED_MESSAGE_FILES_ON_REMOVE.delete,
            messageId: item.id,
            revision: whole.value.revision,
          }),
      );
      if (removed) {
        onEdit(text);
      } else {
        removedHere.current.delete(item.id);
      }
    })();
  };

  const remove = (item: ChatQueueItem) => {
    removedHere.current.add(item.id);
    void (async () => {
      const removed = await write(
        async () =>
          await removeQueuedChatMessage({
            ...request,
            files: QUEUED_MESSAGE_FILES_ON_REMOVE.delete,
            messageId: item.id,
            revision: item.revision,
          }),
      );
      if (!removed) {
        removedHere.current.delete(item.id);
      }
    })();
  };

  const move = (item: ChatQueueItem, beforeId: string | null) => {
    void write(
      async () =>
        await moveQueuedChatMessage({
          ...request,
          beforeId,
          messageId: item.id,
        }),
    );
  };

  const { hold } = queue;
  return (
    <View className="gap-1 px-4 pb-1">
      <View className="flex-row items-center gap-2">
        <Text
          accessibilityLiveRegion="polite"
          className="flex-1"
          variant="caption"
        >
          {hold === null ? t("notice") : t(`held.${hold.reason}`)}
        </Text>
        <Button
          onPress={() => {
            void write(
              async () =>
                await holdChatQueue({
                  ...request,
                  hold: hold === null ? "pause" : "resume",
                }),
            );
          }}
          size="sm"
          variant="ghost"
        >
          {hold === null ? t("pause") : t("resume")}
        </Button>
      </View>
      {queue.items.map((item, index) => (
        <QueueItemRow
          index={index}
          item={item}
          items={queue.items}
          key={item.id}
          notSent={
            hold?.reason === "send-refused" && hold.queuedMessageId === item.id
          }
          on={{ edit, move, remove, sendNow }}
          onPress={() => {
            setOpened((shown) => (shown === item.id ? null : item.id));
          }}
          opened={opened === item.id}
        />
      ))}
    </View>
  );
};

type QueueItemActions = {
  readonly edit: (item: ChatQueueItem) => void;
  readonly move: (item: ChatQueueItem, beforeId: string | null) => void;
  readonly remove: (item: ChatQueueItem) => void;
  readonly sendNow: (item: ChatQueueItem) => void;
};

/**
 * Queued message `items[index]`; tapped, the web's actions on it open
 * under it as buttons (a system alert holds three on Android).
 */
const QueueItemRow = ({
  index,
  item,
  items,
  notSent,
  on,
  onPress,
  opened,
}: {
  readonly index: number;
  readonly item: ChatQueueItem;
  readonly items: readonly ChatQueueItem[];
  readonly notSent: boolean;
  readonly on: QueueItemActions;
  readonly onPress: () => void;
  readonly opened: boolean;
}) => {
  const t = useTranslations("chat.queue");
  const previous = index > 0 ? items.at(index - 1) : undefined;
  const next = items.at(index + 1);
  const actions = [
    {
      label: t("sendNow"),
      run: () => {
        on.sendNow(item);
      },
    },
    // Only a message of text goes back into the phone's composer.
    ...(item.attachmentCount === 0
      ? [
          {
            label: t("edit"),
            run: () => {
              on.edit(item);
            },
          },
        ]
      : []),
    ...(previous === undefined
      ? []
      : [
          {
            label: t("moveUp"),
            run: () => {
              on.move(item, previous.id);
            },
          },
        ]),
    ...(next === undefined
      ? []
      : [
          {
            label: t("moveDown"),
            // Before the one after the next, or last.
            run: () => {
              on.move(item, items.at(index + 2)?.id ?? null);
            },
          },
        ]),
  ];
  return (
    <View className="border-border rounded-xl border px-3 py-2">
      <Pressable
        accessibilityHint={t("actions")}
        accessibilityRole="button"
        accessibilityState={{ expanded: opened }}
        className="active:opacity-70"
        onPress={onPress}
      >
        <Text numberOfLines={2} variant="body">
          {item.preview}
        </Text>
        {item.attachmentCount === 0 ? null : (
          <Text variant="caption">
            {t("attachments", { count: item.attachmentCount })}
          </Text>
        )}
        {notSent ? <Text variant="error">{t("notSent")}</Text> : null}
      </Pressable>
      {opened ? (
        <View
          accessibilityLabel={t("actions")}
          className="flex-row flex-wrap gap-1 pt-2"
        >
          {actions.map(({ label, run }) => (
            <Button
              key={label}
              onPress={() => {
                onPress();
                run();
              }}
              size="sm"
              variant="outline"
            >
              {label}
            </Button>
          ))}
          <Button
            onPress={() => {
              onPress();
              on.remove(item);
            }}
            size="sm"
            variant="destructive"
          >
            {t("remove")}
          </Button>
        </View>
      ) : null}
    </View>
  );
};
