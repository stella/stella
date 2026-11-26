import { useId, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions";
import type { EditorProps } from "@tiptap/pm/view";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  createChatPastedTextPart,
  isChatPastedTextPart,
} from "@stll/api-contract/chat";
import { knownUnscannedContentReasons } from "@stll/api-contract/file-scan-warnings";
import { sleep } from "@stll/concurrency/sleep";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import {
  useExternalSyncEffect,
  useLatestCallback,
  useMountEffect,
} from "@stll/ui/effects";
import { CheckIcon, PencilIcon, TextIcon, XIcon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
import { StatusMark } from "@stll/ui/status-mark";
import { stellaToast } from "@stll/ui/toast";

import {
  useCredentialPasteNotice,
  useCredentialSendNotice,
} from "@/components/chat-composer-paste";
import {
  chatComposerHtml,
  createChatComposerSchemaExtensions,
} from "@/components/chat-composer-schema";
import { useChatEditorManager } from "@/components/chat-editor-provider";
import { containsCredentialCandidate } from "@/components/chat-secret-candidate.logic";
import { AttachmentChip } from "@/components/chat/attachment-chip";
import { ChatImageThumbnailCard } from "@/components/chat/chat-image-attachment";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools-types";
import {
  createUserMessageEditDraft,
  createUserMessageEditSessions,
  hasUserMessageEditContent,
  userMessageEditHandoff,
  userMessageEditNoticeKey,
} from "@/components/chat/user-message-edit.logic";
import type {
  OpenUserMessageEditSession,
  UserMessageEdit,
  UserMessageEditAttachment,
  UserMessageEditDraft,
  UserMessageEditFailure,
  UserMessageEditOutcome,
  UserMessageEditSession,
} from "@/components/chat/user-message-edit.logic";
import { DocumentIcon } from "@/components/document-icon";
import { UnscannedContentMark } from "@/components/inspector/unscanned-content-notice";
import {
  type LocalFilesUndoMessage,
  localFilesUndoOptions,
  requestLocalFilesUndo,
} from "@/features/chat/local-files-undo";
import {
  type EditLocalFilesChoice,
  editLocalFilesChoice,
  editRestartsConversation,
  editUndoesFilesFirst,
  followLocalFilesUndo,
  type LocalFilesUndoProblem,
} from "@/features/chat/local-files-undo.logic";
import { readClientClockMs } from "@/hooks/client-clock";
import { useUnsavedWork } from "@/hooks/use-unsaved-work";
import { useFormatter } from "@/i18n/formatting-context";
import { getAnalytics } from "@/lib/analytics/provider";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import {
  getUserFileContentUrl,
  getUserFileThumbnailUrl,
} from "@/lib/user-files";
import { createUuid } from "@/lib/uuid";

/** What a transcript does when the user edits one of their sent messages. */
export type UserMessageEditActions = {
  /** The thread the edited messages belong to. */
  threadId: string;
  /** The editor opened; a running turn is stopped first. */
  onStart: () => void;
  /** Open an edit session for `messageId`, the message's current one from
   *  now on. */
  openSession: (messageId: string) => OpenUserMessageEditSession;
  /** The edit session `sessionId` opened its form: queued prompts wait. The
   *  release it returns runs when that form closes and lifts only that
   *  session's hold. */
  holdQueue: (sessionId: string) => () => void;
  /** Replace the message with the edit and run the assistant again; resolves
   *  with how the server answered. Whatever it does to the page once the
   *  server answered runs through `session`. */
  onSubmit: (
    messageId: string,
    edit: UserMessageEdit,
    session: UserMessageEditSession,
  ) => Promise<UserMessageEditOutcome>;
};

/**
 * The edit actions a page hands its transcript, built from its chat session:
 * one stable object, so the transcript's edit actions do not re-render while
 * a turn streams. An edit is a send, so it passes the page's AI check first.
 *
 * It owns the page's edit sessions, and with them the one path for an edit
 * whose message leaves the thread, whatever removed it (a refused edit's
 * reload, another tab's edit, a rejoin, a refetch): the current session's
 * latest draft goes into the thread's composer with the target-missing
 * notice, and the session ends. `messages` is the thread as the page shows
 * it; checking it costs nothing while no edit is open.
 */
export const useUserMessageEditActions = ({
  editUserMessage,
  ensureAIAvailable,
  holdQueueForMessageEdit,
  messages,
  startUserMessageEdit,
  threadRef,
}: {
  editUserMessage: (
    messageId: string,
    edit: UserMessageEdit,
    sessionId: string,
  ) => Promise<UserMessageEditOutcome>;
  ensureAIAvailable: () => Promise<boolean>;
  holdQueueForMessageEdit: UserMessageEditActions["holdQueue"];
  messages: readonly Pick<PersistedChatMessage, "id">[];
  startUserMessageEdit: UserMessageEditActions["onStart"];
  threadRef: ChatThreadRef;
}): UserMessageEditActions => {
  const t = useTranslations();
  const format = useFormatter();
  const { restoreMessageDraftIntoThread } = useChatEditorManager();
  const [sessions] = useState(() => createUserMessageEditSessions(createUuid));
  // Bumped when the server answered an edit: the thread then shown, once it
  // has rendered, decides whether that edit's message is still there.
  const [answeredEdits, setAnsweredEdits] = useState(0);
  const handOrphansOn = useLatestCallback(
    (shown: readonly Pick<PersistedChatMessage, "id">[]) => {
      if (!sessions.hasOpen()) {
        return;
      }
      const orphans = sessions.takeOrphans(new Set(shown.map(({ id }) => id)));
      for (const orphan of orphans) {
        const { composer, storedFiles } = userMessageEditHandoff(orphan);
        restoreMessageDraftIntoThread(threadRef, composer);
        // A stored file cannot go back into the composer: the notice names
        // every one that did not come back, so none is lost unseen.
        stellaToast.warning(
          storedFiles.length === 0
            ? t("chat.editMessageRefusedTargetMissing")
            : t("chat.editMessageRefusedTargetMissingFiles", {
                files: format.list(
                  storedFiles.map(
                    (filename) => filename ?? t("chat.attachment"),
                  ),
                ),
              }),
        );
      }
    },
  );
  // The thread the page shows changed, or an edit was answered: an open
  // edit whose message left the thread goes on. The sessions are the
  // external system kept in step with the rendered thread here.
  useExternalSyncEffect(() => {
    handOrphansOn(messages);
  }, [answeredEdits, handOrphansOn, messages]);
  const onStart = useLatestCallback(() => {
    startUserMessageEdit();
  });
  const openSession = useLatestCallback((messageId: string) =>
    sessions.open(messageId),
  );
  const holdQueue = useLatestCallback((sessionId: string) =>
    holdQueueForMessageEdit(sessionId),
  );
  const onSubmit = useLatestCallback(
    async (
      messageId: string,
      edit: UserMessageEdit,
      session: UserMessageEditSession,
    ): Promise<UserMessageEditOutcome> => {
      if (!(await ensureAIAvailable())) {
        return { type: "ai-unavailable" };
      }
      // While the request is out the page shows a rewound thread; once the
      // server answered, the thread it shows decides whether the message
      // is still there.
      const outcome = await sessions.whileSending(
        session,
        async () => await editUserMessage(messageId, edit, session.id),
      );
      setAnsweredEdits((count) => count + 1);
      return outcome;
    },
  );
  const [handlers] = useState(() => ({
    holdQueue,
    onStart,
    onSubmit,
    openSession,
  }));
  const { threadId } = threadRef;
  return { ...handlers, threadId };
};

const attachmentTitle = (
  attachment: UserMessageEditAttachment,
  fallback: string,
): string => {
  const { part } = attachment;
  if (isChatPastedTextPart(part)) {
    return (
      part.content
        .split(/\r\n|\r|\n/u)
        .find((line) => line.trim().length > 0) ?? fallback
    );
  }
  return part.metadata?.filename ?? fallback;
};

const attachmentMimeType = ({ part }: UserMessageEditAttachment): string =>
  !isChatPastedTextPart(part) &&
  "mimeType" in part.source &&
  typeof part.source.mimeType === "string"
    ? part.source.mimeType
    : "application/octet-stream";

/** Enter sends the edit and Escape cancels it; Shift+Enter keeps the
 *  composer's line break. */
const UserMessageEditKeys = Extension.create<{
  onCancel: () => void;
  onSubmit: (editor: Editor) => void;
}>({
  name: "userMessageEditKeys",
  priority: 1000,
  addOptions() {
    return { onCancel: () => undefined, onSubmit: () => undefined };
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        this.options.onSubmit(this.editor);
        return true;
      },
      Escape: () => {
        this.options.onCancel();
        return true;
      },
    };
  },
});

/** A message nobody can read the undo of here: its read never runs. */
const NO_UNDO_TARGET: LocalFilesUndoMessage = {
  activeOrganizationId: "",
  userId: "",
  threadId: "",
  messageId: "",
};

/**
 * The edit form's file choice: the box with its hint, disabled with the
 * reason when the changes cannot be undone, or where an undo stands.
 */
const EditLocalFilesChoiceView = ({
  choice,
  disabled,
  hintId,
  onCheckedChange,
  undoing,
}: {
  choice: EditLocalFilesChoice;
  /** A send is out: the choice it made stays as it is. */
  disabled: boolean;
  hintId: string;
  onCheckedChange: (checked: boolean) => void;
  /** This form's send is undoing the files now. */
  undoing: boolean;
}) => {
  const t = useTranslations();
  if (undoing) {
    return <LocalFilesUndoPending />;
  }
  switch (choice.type) {
    case "hidden":
      return null;
    case "pending":
      return <LocalFilesUndoPending />;
    case "restored":
      return (
        <p
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          role="status"
        >
          <CheckIcon aria-hidden="true" className="size-3.5" />
          {t("chat.localFilesUndo.restored")}
        </p>
      );
    case "offered":
    case "unavailable":
      return (
        <div className="flex flex-col">
          <Label variant="choice">
            <Checkbox
              aria-describedby={hintId}
              checked={choice.type === "offered" && choice.checked}
              disabled={disabled || choice.type === "unavailable"}
              onCheckedChange={onCheckedChange}
            />
            {t("chat.localFilesUndo.option")}
          </Label>
          <p className="text-muted-foreground ps-7 text-xs" id={hintId}>
            {choice.type === "unavailable"
              ? t(choice.reasonKey)
              : t("chat.localFilesUndo.optionHint")}
          </p>
          {choice.type === "offered" && choice.problemKey !== null && (
            <p className="text-destructive ps-7 pt-1 text-xs" role="alert">
              {t(choice.problemKey)}
            </p>
          )}
        </div>
      );
    default:
      choice satisfies never;
      return panic("Unhandled edit file choice");
  }
};

/** An undo on its way to the member's computer. */
const LocalFilesUndoPending = () => {
  const t = useTranslations();
  return (
    <p
      className="text-muted-foreground flex items-center gap-1.5 text-xs"
      role="status"
    >
      {/* A settled mark beside the text: the undo waits on the computer,
          and the turn status owner is the chat's only live indicator. */}
      <StatusMark status="pending" />
      {t("chat.localFilesUndo.pending")}
    </p>
  );
};

/** A kept file's chip says what was not scanned of it, as in the thread. */
const AttachmentUnscannedContent = ({
  part,
}: {
  part: UserMessageEditAttachment["part"];
}) =>
  isChatPastedTextPart(part) ? null : (
    <UnscannedContentMark
      reasons={knownUnscannedContentReasons(part.metadata?.unscannedContent)}
    />
  );

type UserMessageEditFormProps = {
  draft: UserMessageEditDraft;
  /** The edited message and its thread: an edit from it may first undo the
   *  file changes made on the member's computer since. */
  messageId: string;
  threadId: string;
  isGenerating: boolean;
  onCancel: () => void;
  /** Runs once the form is open; the release it returns runs when it
   *  closes. */
  onHold: () => () => void;
  onSubmit: (edit: UserMessageEdit) => Promise<UserMessageEditOutcome>;
  /** The edit session the form belongs to; the form's reaction to an
   *  answer runs through it. */
  session: UserMessageEditSession;
};

/**
 * The sent message, back in an editor with the composer's own content: its
 * paragraphs, line breaks, bold text and chips load as the composer holds
 * them, and sending writes the markup a new message would carry.
 */
const sendDisabledKey = ({
  sending,
  isGenerating,
}: {
  sending: boolean;
  isGenerating: boolean;
}) => {
  if (sending) {
    return "common.sending";
  }
  return isGenerating
    ? "chat.answerEdit.waitForAnswer"
    : "chat.sendPromptEmpty";
};

type UserMessageEditAttachmentsProps = {
  attachments: readonly UserMessageEditAttachment[];
  onRemove: (id: string) => void;
  sending: boolean;
};

const UserMessageEditAttachments = ({
  attachments,
  onRemove,
  sending,
}: UserMessageEditAttachmentsProps) => {
  const t = useTranslations();
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-start gap-2">
      {attachments.map((attachment) => {
        const title = attachmentTitle(attachment, t("chat.attachment"));
        const pasted = isChatPastedTextPart(attachment.part);
        const mimeType = attachmentMimeType(attachment);
        const removeLabel = t("chat.editMessageRemoveAttachment", {
          name: title,
        });
        const removeAttachment = () => onRemove(attachment.id);
        if (
          !isChatPastedTextPart(attachment.part) &&
          mimeType.startsWith("image/")
        ) {
          const url = attachment.part.source.value;
          const contentUrl = getUserFileContentUrl(url) ?? undefined;
          const thumbnailUrl =
            (attachment.part.metadata?.placeholder !== undefined
              ? getUserFileThumbnailUrl(url)
              : null) ?? contentUrl;
          return (
            <ChatImageThumbnailCard
              filename={title}
              fullSrc={contentUrl}
              key={attachment.id}
              mimeType={mimeType}
              remove={
                sending
                  ? undefined
                  : { label: removeLabel, onRemove: removeAttachment }
              }
              thumbnailSrc={thumbnailUrl}
            />
          );
        }
        return (
          <AttachmentChip
            // A sent draft is read-only until the server answers.
            actions={
              sending
                ? []
                : [
                    {
                      type: "remove",
                      label: removeLabel,
                      icon: ({ className }) => (
                        <XIcon aria-hidden="true" className={className} />
                      ),
                      onClick: removeAttachment,
                    },
                  ]
            }
            icon={({ className }) =>
              pasted ? (
                <TextIcon aria-hidden="true" className={className} />
              ) : (
                <DocumentIcon className={className} mimeType={mimeType} />
              )
            }
            key={attachment.id}
            kind={pasted ? "pasted_text" : "file"}
            notice={<AttachmentUnscannedContent part={attachment.part} />}
            title={title}
          />
        );
      })}
    </div>
  );
};

const UserMessageEditForm = ({
  draft,
  isGenerating,
  messageId,
  onCancel,
  onHold,
  onSubmit,
  session,
  threadId,
}: UserMessageEditFormProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const user = useMaybeAuthenticatedUser();
  const optionHintId = useId();
  const [attachments, setAttachments] = useState(draft.attachments);
  // The file undo an edit may ask first. The box starts unchecked: undoing
  // also takes away the member's own changes in the folder.
  const [undoFiles, setUndoFiles] = useState(false);
  const [undoProblem, setUndoProblem] = useState<LocalFilesUndoProblem | null>(
    null,
  );
  // While a send follows its undo, the form's own reads do; the query's poll
  // waits.
  const [undoing, setUndoing] = useState(false);
  const [openedAt] = useState(readClientClockMs);
  const undoTarget: LocalFilesUndoMessage | null =
    user === null
      ? null
      : {
          activeOrganizationId: user.activeOrganizationId,
          userId: user.id,
          threadId,
          messageId,
        };
  const undoOptions = localFilesUndoOptions(undoTarget ?? NO_UNDO_TARGET, {
    followedSince: openedAt,
    follow: !undoing,
  });
  const undoRead = queryView(
    useQuery({ ...undoOptions, enabled: undoTarget !== null }),
  );
  useQueryViewError(undoRead, "UserMessageEdit:localFilesUndo");
  // A read that failed or has not arrived offers nothing: the edit alone.
  const read = undoRead.type === "items" ? undoRead.items : undefined;
  const filesChoice = editLocalFilesChoice({
    read,
    checked: undoFiles,
    problem: undoProblem,
  });
  /** Whether this form's edit session is still the open one. */
  const sessionOpen = () => {
    let open = false;
    session.run(() => {
      open = true;
    });
    return open;
  };
  /** Ask for the undo and follow it while this form's session is open. */
  const undoFilesFirst = async (target: LocalFilesUndoMessage) =>
    await Result.tryPromise(
      async () =>
        await followLocalFilesUndo({
          request: async () => await requestLocalFilesUndo(target),
          read: async () =>
            await Result.tryPromise(
              async () =>
                await queryClient.query({ ...undoOptions, staleTime: 0 }),
            ),
          wait: async (ms) => {
            await sleep(ms);
            return sessionOpen();
          },
          now: readClientClockMs,
        }),
    );
  // Sending stays in this form until the server answers: an accepted edit
  // closes it, any other outcome leaves the draft here with its notice.
  const [sending, setSending] = useState(false);
  // Read by the editor's key handler, which can run before a render commits:
  // a second Enter while an edit is in flight never sends it twice.
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<UserMessageEditFailure | null>(null);
  // While the form is open the session holds its queued prompts.
  useMountEffect(onHold);
  // The editor outlives a render, so its handlers read the latest props.
  const sendFrom = useLatestCallback((current: Editor) => {
    const edit: UserMessageEdit = {
      attachments: attachments.map(({ part }) => part),
      html: chatComposerHtml(current),
    };
    if (!hasUserMessageEditContent(edit) || isGenerating || inFlight.current) {
      return;
    }
    const undoFirst = editUndoesFilesFirst(filesChoice) ? undoTarget : null;
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    setUndoProblem(null);
    setUndoing(undoFirst !== null);
    detached(
      (async () => {
        // The folder goes back first: the computer refuses a turn in a
        // folder it is still restoring. An undo that did not restore it
        // sends nothing and leaves the draft here, the box unchecked.
        if (undoFirst !== null) {
          const followed = await undoFilesFirst(undoFirst);
          if (followed.isErr()) {
            getAnalytics().captureError(followed.error, {
              fingerprintKey: "UserMessageEdit:undoLocalFiles",
              scope: {
                type: "handler",
                handlerId: "UserMessageEdit:undoLocalFiles",
              },
            });
            session.run(() => {
              inFlight.current = false;
              setSending(false);
              setUndoing(false);
              notifyUserError(followed.error, t("errors.actionFailed"));
            });
            return;
          }
          const end = followed.value;
          if (end.type !== "restored") {
            session.run(() => {
              inFlight.current = false;
              setSending(false);
              setUndoing(false);
              setUndoFiles(false);
              if (end.type !== "abandoned") {
                setUndoProblem(end);
              }
            });
            return;
          }
          // The form may have closed while the undo was followed: a closed
          // or replaced edit sends nothing, the folder stays restored.
          if (!sessionOpen()) {
            return;
          }
          setUndoing(false);
        }
        const outcome = await onSubmit(edit);
        if (outcome.type !== "accepted") {
          session.run(() => {
            inFlight.current = false;
            setSending(false);
            setFailure(outcome);
          });
        }
      })(),
      "user-message-edit.submit",
    );
  });
  // An edit is a sent message: it is held, as one from the composer is, when
  // its text looks like a credential.
  const warnCredentialSend = useCredentialSendNotice();
  const submitFrom = useLatestCallback((current: Editor) => {
    if (containsCredentialCandidate(current.getText())) {
      // "Send anyway" can come after the form closed (its editor is gone):
      // it sends only while this edit's session is still open.
      warnCredentialSend(() => {
        session.run(() => {
          sendFrom(current);
        });
      });
      return;
    }
    sendFrom(current);
  });
  const cancel = useLatestCallback(() => {
    onCancel();
  });
  // A long paste travels as a pasted-text attachment, as from the composer.
  const addPastedText = useLatestCallback((text: string) => {
    setAttachments((current) => [
      ...current,
      { id: createUuid(), part: createChatPastedTextPart(text) },
    ]);
  });
  const warnCredential = useCredentialPasteNotice();
  const [extensions] = useState(() => [
    // The composer's schema and its paste pipeline: a paste lands here as it
    // lands in a new message.
    ...createChatComposerSchemaExtensions({
      onChip: addPastedText,
      onCredential: warnCredential,
    }),
    UndoRedo,
    UserMessageEditKeys.configure({ onCancel: cancel, onSubmit: submitFrom }),
  ]);
  const [editorProps] = useState<EditorProps>(() => ({
    attributes: {
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": t("chat.editMessageInput"),
      dir: "auto",
      class: "min-h-10 text-sm wrap-anywhere focus-visible:outline-none",
    },
  }));
  const editor = useEditor({
    autofocus: "end",
    content: draft.content,
    editorProps,
    extensions,
  });
  const html = useEditorState({
    editor,
    selector: ({ editor: current }) => chatComposerHtml(current),
  });
  // The session keeps the form's current draft, so it survives the form if
  // the message leaves the thread. Written as the form changes; nothing
  // reads it then, so nothing re-renders.
  useExternalSyncEffect(() => {
    session.mirror({ attachments: attachments.map(({ part }) => part), html });
  }, [attachments, html, session]);
  // While a send is out the draft is read-only, as the composer is while it
  // sends: what goes to the server is what the user sees, and an accepted
  // edit closes nothing the user changed since. A refusal hands it back.
  useExternalSyncEffect(() => {
    editor.setEditable(!sending);
  }, [editor, sending]);
  // A changed edit is unsaved work: closing the tab asks first. The markup
  // compares formatting and chips too, not only the text.
  const [openedHtml] = useState(html);
  useUnsavedWork({
    guard: "unload",
    isDirty: html !== openedHtml || attachments !== draft.attachments,
    surface: "chat-message-edit",
  });
  const canSend =
    hasUserMessageEditContent({
      attachments: attachments.map(({ part }) => part),
      html,
    }) &&
    !isGenerating &&
    !sending;

  return (
    <div className="flex w-full min-w-0 flex-col gap-2" data-chat-message-edit>
      <UserMessageEditAttachments
        attachments={attachments}
        onRemove={(id) => {
          setAttachments(
            attachments.filter((candidate) => candidate.id !== id),
          );
        }}
        sending={sending}
      />
      <div className="border-input bg-background focus-within:border-ring focus-within:ring-ring/24 rounded-lg border px-2.5 py-2 focus-within:ring-3">
        <EditorContent editor={editor} />
      </div>
      <p className="text-muted-foreground text-xs">
        {t("chat.editMessageNotice")}
      </p>
      {editRestartsConversation(read) && (
        <p className="text-muted-foreground text-xs">
          {t("chat.localFilesUndo.conversationRestarts")}
        </p>
      )}
      <EditLocalFilesChoiceView
        choice={filesChoice}
        disabled={sending}
        hintId={optionHintId}
        onCheckedChange={(checked) => {
          setUndoFiles(checked);
          setUndoProblem(null);
        }}
        undoing={undoing}
      />
      {failure !== null && (
        <p className="text-destructive text-xs" role="alert">
          {t(userMessageEditNoticeKey(failure))}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" variant="ghost">
          {t("common.cancel")}
        </Button>
        <Button
          disabled={!canSend}
          disabledReason={t(sendDisabledKey({ sending, isGenerating }))}
          onClick={() => {
            submitFrom(editor);
          }}
          size="sm"
        >
          {t("chat.sendPrompt")}
        </Button>
      </div>
    </div>
  );
};

type UserMessageEditOptions = {
  /** Omitted on surfaces that offer no editing. */
  actions: UserMessageEditActions | undefined;
  /** A turn still runs: the edit can be sent once it has stopped. */
  isGenerating: boolean;
  message: Pick<PersistedChatMessage, "id" | "parts" | "role">;
};

/**
 * The edit action of a sent user message: `editor` is its pencil, or while
 * editing the form that holds the message's content and attachments, shown in
 * place of the message body (`editing`). Cancel puts the message back as it
 * was; send replaces it, dropping every later turn.
 */
export const useUserMessageEdit = ({
  actions,
  isGenerating,
  message,
}: UserMessageEditOptions): {
  editing: boolean;
  editor: ReactElement | null;
} => {
  const t = useTranslations();
  // Every opening of the form is its own session (`actions.openSession`):
  // what an answer does to the page applies only while the session that
  // asked is still the message's open one.
  const [open, setOpen] = useState<{
    draft: UserMessageEditDraft;
    session: OpenUserMessageEditSession;
  } | null>(null);

  if (actions === undefined || message.role !== "user") {
    return { editing: false, editor: null };
  }

  if (open !== null) {
    const { draft, session } = open;
    const close = () => {
      session.end();
      setOpen(null);
    };
    const submitEdit = async (
      edit: UserMessageEdit,
    ): Promise<UserMessageEditOutcome> => {
      const outcome = await actions.onSubmit(message.id, edit, session);
      // The sent copy takes this message's id and place once the server
      // accepted it; until then, and after any refusal, the form stays open
      // on the draft.
      if (outcome.type === "accepted") {
        session.run(close);
      }
      return outcome;
    };
    return {
      editing: true,
      editor: (
        <UserMessageEditForm
          draft={draft}
          isGenerating={isGenerating}
          key={session.id}
          onCancel={close}
          messageId={message.id}
          onHold={() => actions.holdQueue(session.id)}
          onSubmit={submitEdit}
          session={session}
          threadId={actions.threadId}
        />
      ),
    };
  }

  return {
    editing: false,
    editor: (
      // Shown on hover of the message (the `group` of `Message`), on focus and
      // on touch; hidden while the sticky layout pins the message as a
      // compact header. It sits just outside the bubble's start edge, level
      // with its last line, so it never adds a row under the text or covers
      // it: the bubble (`MessageContent`) is its anchor, and a bubble never
      // spans the whole column, so the space beside it is free. A touch
      // screen always shows it there.
      <div className="absolute end-full bottom-0.5 me-1 opacity-0 transition-opacity group-hover:opacity-100 group-data-[stuck=true]/sticky:hidden focus-within:opacity-100 pointer-coarse:opacity-100">
        <Button
          aria-label={t("chat.editMessage")}
          onClick={() => {
            actions.onStart();
            setOpen({
              draft: createUserMessageEditDraft(message, createUuid),
              session: actions.openSession(message.id),
            });
          }}
          size="icon-xs"
          variant="ghost"
        >
          <PencilIcon className="size-3.5" />
        </Button>
      </div>
    ),
  };
};

/** A sent user message body with its edit action beside the bubble. */
export const EditableUserMessage = ({
  children,
  ...options
}: UserMessageEditOptions & { children: ReactNode }) => {
  const { editing, editor } = useUserMessageEdit(options);
  if (editing) {
    return editor;
  }
  return (
    <div className="flex min-w-0 flex-col">
      {children}
      {editor}
    </div>
  );
};
