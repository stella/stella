import { useEffect, useEffectEvent, useRef, useState } from "react";

import { panic, Result } from "better-result";
import { ActionSheetIOS, Alert, Platform, View } from "react-native";
import { useTranslations } from "use-intl";

import type { ChatLocalFilesUndoRead } from "@stll/api-contract/chat-local-files-undo";
import { sleep } from "@stll/concurrency/sleep";
import { Button } from "@stll/ui/button";
import { Switch } from "@stll/ui/switch";
import { Text } from "@stll/ui/text";
import { Textarea } from "@stll/ui/textarea";

import { ChatAttachmentChip } from "@/components/chat-attachment-chip";
import type { useChatTurn } from "@/components/use-chat-turn";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import {
  type EditDraft,
  editDraftOf,
  editedEntry,
  editedMessageParts,
  type EditFilesChoice,
  editFilesChoice,
  type EditNotice,
  editNoticeOf,
  editRestartsConversation,
  editUndoesFilesFirst,
  entriesBefore,
  followLocalFilesUndo,
  hasEditContent,
  localFilesReadPollMs,
  type LocalFilesUndoProblem,
  type MessageAction,
  messageActions,
  readLocalFilesUndo,
  requestLocalFilesUndo,
} from "@/state/chat-edit";
import type { ChatEntry } from "@/state/chat-messages";
import type { LocalRunTarget } from "@/state/chat-pending-input";

/** How the thread answered an edit the form sent. */
export type EditOutcome =
  | { readonly type: "accepted" }
  | { readonly type: "refused"; readonly notice: EditNotice };

/**
 * The form that edits one of the person's sent messages ("Edit from here"),
 * in the composer's place: the message's text, the files and pasted texts
 * it carries on (each can be taken off), the web's notice that sending
 * replaces this message and every later one, and, in a chat that runs on
 * the person's computer, the choice to also undo the file changes made
 * there since, off by default because it also undoes the person's own
 * changes in the folder. Sending with it on asks the computer first and
 * sends the edit only once the folder is back; an undo that did not finish
 * leaves the draft here with why. `onSend` resolves with the thread's
 * answer: an accepted edit closes the form, a refusal keeps it with its
 * notice.
 */
const ChatMessageEdit = ({
  busy,
  entry,
  onCancel,
  onSend,
  source,
  threadId,
}: {
  /** A turn still runs: the edit can be sent once it has stopped. */
  busy: boolean;
  /** The stored message being edited. */
  entry: ChatEntry;
  onCancel: () => void;
  onSend: (draft: EditDraft) => Promise<EditOutcome>;
  source: AccessTokenSource;
  threadId: string;
}) => {
  const t = useTranslations("chat");
  const { end } = useSession();
  const [opened] = useState(() => editDraftOf(entry.parts ?? []));
  const [text, setText] = useState(opened.text);
  const [kept, setKept] = useState(opened.kept);
  const [read, setRead] = useState<ChatLocalFilesUndoRead>();
  const [undoFiles, setUndoFiles] = useState(false);
  const [problem, setProblem] = useState<LocalFilesUndoProblem | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<EditNotice>();
  // Read by the follow, which outlives a render: the form may close meanwhile.
  const open = useRef(true);
  const target = { fetch, messageId: entry.id, source, threadId };

  const signedOut = (error: ApiError) => {
    if (error._tag !== "SignedOutError") {
      return false;
    }
    end(source);
    return true;
  };

  /**
   * Reads what the edit does on the computer, and again after a pause while
   * that may still change: an undo on its way, or the turn the form stopped
   * as it opened still ending.
   */
  const followRead = useEffectEvent(() => {
    const openedAt = epochMilliseconds();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const result = await readLocalFilesUndo(target);
      if (!open.current) {
        return;
      }
      if (Result.isError(result) && signedOut(result.error)) {
        return;
      }
      // A read that failed offers nothing: the edit alone.
      const current = Result.isOk(result) ? result.value : undefined;
      if (current !== undefined) {
        setRead(current);
      }
      const pause = localFilesReadPollMs({
        read: current,
        followedForMs: epochMilliseconds() - openedAt,
      });
      if (pause !== false) {
        timer = setTimeout(() => {
          void load();
        }, pause);
      }
    };
    void load();
    return () => {
      clearTimeout(timer);
    };
  });

  useEffect(() => {
    open.current = true;
    const stop = followRead();
    return () => {
      open.current = false;
      stop();
    };
  }, []);

  const choice = editFilesChoice({ read, checked: undoFiles, problem });
  const draft: EditDraft = { text, kept };
  const canSend = hasEditContent(draft) && !busy && !sending;

  /** Asks the computer to undo the files and follows it while the form is open. */
  const undoFilesFirst = async () =>
    await followLocalFilesUndo({
      now: epochMilliseconds,
      read: async () => {
        const current = await readLocalFilesUndo(target);
        if (Result.isOk(current) && open.current) {
          setRead(current.value);
        }
        return current;
      },
      request: async () => await requestLocalFilesUndo(target),
      wait: async (ms) => {
        await sleep(ms);
        return open.current;
      },
    });

  const send = () => {
    if (!canSend) {
      return;
    }
    const undoFirst = editUndoesFilesFirst(choice);
    setSending(true);
    setNotice(undefined);
    setProblem(null);
    setUndoing(undoFirst);
    void (async () => {
      // The folder goes back first: the computer refuses a turn in a folder
      // it is still restoring. An undo that did not restore it sends nothing
      // and leaves the draft here, the switch off.
      if (undoFirst) {
        const followed = await undoFilesFirst();
        if (!open.current) {
          return;
        }
        setUndoing(false);
        if (Result.isError(followed)) {
          setSending(false);
          if (!signedOut(followed.error)) {
            setNotice("failed");
          }
          return;
        }
        const ended = followed.value;
        if (ended.type !== "restored") {
          setSending(false);
          setUndoFiles(false);
          if (ended.type !== "abandoned") {
            setProblem(ended);
          }
          return;
        }
      }
      const outcome = await onSend(draft);
      if (outcome.type === "refused" && open.current) {
        setSending(false);
        setNotice(outcome.notice);
      }
    })();
  };

  return (
    <View className="gap-2 px-4 pt-2 pb-3">
      <Text accessibilityRole="header" variant="label">
        {t("edit.title")}
      </Text>
      {kept.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-2">
          {kept.map((attachment) => (
            <ChatAttachmentChip
              key={attachment.key}
              mimeType={attachment.mimeType}
              name={attachment.name}
              onRemove={
                sending
                  ? undefined
                  : () => {
                      setKept((current) =>
                        current.filter(({ key }) => key !== attachment.key),
                      );
                    }
              }
            />
          ))}
        </View>
      )}
      <Textarea
        accessibilityLabel={t("edit.input")}
        autoFocus
        editable={!sending}
        onChangeText={setText}
        value={text}
      />
      <Text variant="caption">{t("edit.notice")}</Text>
      {editRestartsConversation(read) ? (
        <Text variant="caption">
          {t("edit.localFiles.conversationRestarts")}
        </Text>
      ) : null}
      <FilesChoice
        choice={choice}
        disabled={sending}
        onCheckedChange={(checked) => {
          setUndoFiles(checked);
          setProblem(null);
        }}
        undoing={undoing}
      />
      {notice === undefined ? null : <EditNoticeText notice={notice} />}
      <View className="flex-row justify-end gap-2">
        <Button onPress={onCancel} size="sm" variant="ghost">
          {t("edit.cancel")}
        </Button>
        <Button disabled={!canSend} loading={sending} onPress={send} size="sm">
          {t("send")}
        </Button>
      </View>
    </View>
  );
};

type ChatTurn = ReturnType<typeof useChatTurn>;

/**
 * Editing the thread's stored messages: what a long press on a message
 * opens, and the edit form of the one being edited (`form`, null while none
 * is), which takes the composer's place; the composer stays mounted under
 * it, so its draft survives the edit. Opening the form stops a turn still
 * answering, as on the web. Once the server took an edit, the message and
 * every later one leave the loaded thread (`setEntries`), so the stored
 * thread read after the answer follows the messages before it; refused,
 * the thread is read again (`onRefused`), as it may have changed under it.
 */
export const useMessageEdit = ({
  localRunTarget,
  onRefused,
  setEntries,
  source,
  threadId,
  turn,
}: {
  localRunTarget: LocalRunTarget | undefined;
  onRefused: () => Promise<unknown>;
  setEntries: (
    update: (loaded: readonly ChatEntry[]) => readonly ChatEntry[],
  ) => void;
  source: AccessTokenSource;
  threadId: string;
  turn: Pick<ChatTurn, "busy" | "canStop" | "edit" | "stop">;
}) => {
  const [editing, setEditing] = useState<ChatEntry | null>(null);
  const openMenu = useMessageActionsMenu((action, entry) => {
    switch (action) {
      case "edit":
        if (turn.canStop) {
          turn.stop();
        }
        setEditing(entry);
        return;
      default:
        action satisfies never;
        panic("Unhandled message action");
    }
  });
  const send = async (entry: ChatEntry, draft: EditDraft) =>
    await new Promise<EditOutcome>((resolve) => {
      const started = turn.edit(
        {
          parts: editedMessageParts(draft),
          question: editedEntry({
            createdAt: new Date(epochMilliseconds()).toISOString(),
            draft,
            messageId: entry.id,
          }),
          runTarget: localRunTarget,
        },
        {
          onAccepted: () => {
            setEntries((loaded) => entriesBefore(loaded, entry.id));
            setEditing(null);
            resolve({ type: "accepted" });
          },
          onRefused: (error) => {
            void onRefused();
            resolve({
              type: "refused",
              notice: editNoticeOf(error, draft.kept.length > 0),
            });
          },
        },
      );
      if (!started) {
        resolve({ type: "refused", notice: "refused" });
      }
    });
  return {
    form:
      editing === null ? null : (
        <ChatMessageEdit
          busy={turn.busy}
          entry={editing}
          key={editing.id}
          onCancel={() => {
            setEditing(null);
          }}
          onSend={async (draft) => await send(editing, draft)}
          source={source}
          threadId={threadId}
        />
      ),
    /** What a long press on `entry` does; nothing for one that offers nothing. */
    longPressOf: (entry: ChatEntry) =>
      messageActions(entry).length === 0
        ? undefined
        : () => {
            openMenu(entry);
          },
  };
};

/**
 * Opens the actions a long press on a message offers, as the system's
 * sheet on iOS and an alert elsewhere; nothing for a message that offers
 * none.
 */
const useMessageActionsMenu = (
  onAction: (action: MessageAction, entry: ChatEntry) => void,
): ((entry: ChatEntry) => void) => {
  const t = useTranslations("chat");
  return (entry) => {
    const actions = messageActions(entry);
    if (actions.length === 0) {
      return;
    }
    const label = (action: MessageAction) => {
      switch (action) {
        case "edit":
          return t("edit.action");
        default:
          action satisfies never;
          return panic("Unhandled message action");
      }
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          cancelButtonIndex: actions.length,
          options: [...actions.map(label), t("edit.cancel")],
        },
        (index) => {
          const action = actions[index];
          if (action !== undefined) {
            onAction(action, entry);
          }
        },
      );
      return;
    }
    Alert.alert(t("edit.title"), undefined, [
      { style: "cancel", text: t("edit.cancel") },
      ...actions.map((action) => ({
        onPress: () => {
          onAction(action, entry);
        },
        text: label(action),
      })),
    ]);
  };
};

/**
 * The form's file choice: the switch with its hint, off and disabled with
 * the reason when the changes cannot be undone, or where an undo stands.
 */
const FilesChoice = ({
  choice,
  disabled,
  onCheckedChange,
  undoing,
}: {
  choice: EditFilesChoice;
  /** A send is out: the choice it made stays as it is. */
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** This form's send is undoing the files now. */
  undoing: boolean;
}) => {
  const t = useTranslations("chat");
  if (undoing) {
    return <Text variant="caption">{t("edit.localFiles.pending")}</Text>;
  }
  switch (choice.type) {
    case "hidden":
      return null;
    case "pending":
      return <Text variant="caption">{t("edit.localFiles.pending")}</Text>;
    case "restored":
      return <Text variant="caption">{t("edit.localFiles.restored")}</Text>;
    case "offered":
    case "unavailable":
      return (
        <View className="gap-1">
          <View className="flex-row items-center gap-3">
            <Text className="flex-1">{t("edit.localFiles.option")}</Text>
            <Switch
              accessibilityLabel={t("edit.localFiles.option")}
              checked={choice.type === "offered" && choice.checked}
              disabled={disabled || choice.type === "unavailable"}
              onCheckedChange={onCheckedChange}
            />
          </View>
          <Text variant="caption">
            {choice.type === "unavailable"
              ? t(`edit.localFiles.${choice.reasonKey}`)
              : t("edit.localFiles.optionHint")}
          </Text>
          {choice.type === "offered" && choice.problemKey !== null ? (
            <Text variant="error">
              {t(`edit.localFiles.${choice.problemKey}`)}
            </Text>
          ) : null}
        </View>
      );
    default:
      choice satisfies never;
      return panic("Unhandled edit file choice");
  }
};

/** What the form says of an edit the thread did not take, in the web's words. */
const EditNoticeText = ({ notice }: { notice: EditNotice }) => {
  const t = useTranslations("chat");
  const text = {
    refused: t("edit.refused"),
    "history-changed": t("edit.refusedHistoryChanged"),
    "target-missing": t("edit.refusedTargetMissing"),
    failed: t("sendFailed"),
    "file-refused": t("sendFileRefused"),
    "file-not-anonymizable": t("sendFileNotAnonymizable"),
    "local-run-not-anonymizable": t("sendLocalRunNotAnonymizable"),
  } as const satisfies Record<EditNotice, string>;
  return <Text variant="error">{text[notice]}</Text>;
};
