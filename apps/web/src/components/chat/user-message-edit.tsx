import { useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions";
import type { EditorProps } from "@tiptap/pm/view";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { useTranslations } from "use-intl";

import {
  createChatPastedTextPart,
  isChatPastedTextPart,
} from "@stll/api-contract/chat";
import { Button } from "@stll/ui/button";
import { PencilIcon, TextIcon, XIcon } from "@stll/ui/icons";
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
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import {
  createUserMessageEditDraft,
  hasUserMessageEditContent,
  userMessageEditHandoff,
  userMessageEditNoticeKey,
} from "@/components/chat/user-message-edit.logic";
import type {
  UserMessageEdit,
  UserMessageEditAttachment,
  UserMessageEditDraft,
  UserMessageEditFailure,
  UserMessageEditOutcome,
  UserMessageEditResult,
} from "@/components/chat/user-message-edit.logic";
import { DocumentIcon } from "@/components/document-icon";
import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { createUuid } from "@/lib/uuid";

/** What a transcript does when the user edits one of their sent messages. */
export type UserMessageEditActions = {
  /** The editor opened; a running turn is stopped first. */
  onStart: () => void;
  /** An edit form of `messageId` is open: queued prompts wait. The release
   *  it returns runs when the form closes, and the queue resumes. */
  holdQueue: (messageId: string) => () => void;
  /** Replace the message with the edit and run the assistant again; resolves
   *  with how the server answered. */
  onSubmit: (
    messageId: string,
    edit: UserMessageEdit,
  ) => Promise<UserMessageEditOutcome>;
};

/**
 * The edit actions a page hands its transcript, built from its chat session:
 * one stable object, so the transcript's edit actions do not re-render while
 * a turn streams. An edit is a send, so it passes the page's AI check first.
 * An edit whose message the thread no longer holds goes into the thread's
 * composer with its notice: its form went with the message, the edit stays.
 */
export const useUserMessageEditActions = ({
  editUserMessage,
  ensureAIAvailable,
  holdQueueForMessageEdit,
  startUserMessageEdit,
  threadRef,
}: {
  editUserMessage: (
    messageId: string,
    edit: UserMessageEdit,
  ) => Promise<UserMessageEditResult>;
  ensureAIAvailable: () => Promise<boolean>;
  holdQueueForMessageEdit: UserMessageEditActions["holdQueue"];
  startUserMessageEdit: UserMessageEditActions["onStart"];
  threadRef: ChatThreadRef;
}): UserMessageEditActions => {
  const t = useTranslations();
  const { restoreMessageDraftIntoThread } = useChatEditorManager();
  const onStart = useLatestCallback(() => {
    startUserMessageEdit();
  });
  const holdQueue = useLatestCallback((messageId: string) =>
    holdQueueForMessageEdit(messageId),
  );
  const onSubmit = useLatestCallback(
    async (
      messageId: string,
      edit: UserMessageEdit,
    ): Promise<UserMessageEditOutcome> => {
      if (!(await ensureAIAvailable())) {
        return { type: "ai-unavailable" };
      }
      const { orphanedEdit, outcome } = await editUserMessage(messageId, edit);
      if (orphanedEdit !== null) {
        restoreMessageDraftIntoThread(
          threadRef,
          userMessageEditHandoff(orphanedEdit),
        );
        stellaToast.warning(t(userMessageEditNoticeKey(outcome)));
      }
      return outcome;
    },
  );
  const [actions] = useState<UserMessageEditActions>(() => ({
    holdQueue,
    onStart,
    onSubmit,
  }));
  return actions;
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

type UserMessageEditFormProps = {
  draft: UserMessageEditDraft;
  isGenerating: boolean;
  onCancel: () => void;
  /** Runs once the form is open; the release it returns runs when it
   *  closes. */
  onHold: () => () => void;
  onSubmit: (edit: UserMessageEdit) => Promise<UserMessageEditOutcome>;
};

/**
 * The sent message, back in an editor with the composer's own content: its
 * paragraphs, line breaks, bold text and chips load as the composer holds
 * them, and sending writes the markup a new message would carry.
 */
const UserMessageEditForm = ({
  draft,
  isGenerating,
  onCancel,
  onHold,
  onSubmit,
}: UserMessageEditFormProps) => {
  const t = useTranslations();
  const [attachments, setAttachments] = useState(draft.attachments);
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
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    detached(
      (async () => {
        const outcome = await onSubmit(edit);
        if (outcome.type !== "accepted") {
          inFlight.current = false;
          setSending(false);
          setFailure(outcome);
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
      warnCredentialSend(() => {
        sendFrom(current);
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
      class:
        "field-sizing-content min-h-10 text-sm wrap-anywhere focus-visible:outline-none",
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
  const canSend =
    hasUserMessageEditContent({
      attachments: attachments.map(({ part }) => part),
      html,
    }) &&
    !isGenerating &&
    !sending;

  return (
    <div className="flex w-full min-w-0 flex-col gap-2" data-chat-message-edit>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((attachment) => {
            const title = attachmentTitle(attachment, t("chat.attachment"));
            const pasted = isChatPastedTextPart(attachment.part);
            return (
              <AttachmentChip
                actions={[
                  {
                    type: "remove",
                    label: t("chat.editMessageRemoveAttachment", {
                      name: title,
                    }),
                    icon: ({ className }) => (
                      <XIcon aria-hidden="true" className={className} />
                    ),
                    onClick: () => {
                      setAttachments(
                        attachments.filter(
                          (candidate) => candidate.id !== attachment.id,
                        ),
                      );
                    },
                  },
                ]}
                icon={({ className }) =>
                  pasted ? (
                    <TextIcon aria-hidden="true" className={className} />
                  ) : (
                    <DocumentIcon
                      className={className}
                      mimeType={attachmentMimeType(attachment)}
                    />
                  )
                }
                key={attachment.id}
                kind={pasted ? "pasted_text" : "file"}
                title={title}
              />
            );
          })}
        </div>
      )}
      <div className="border-input bg-background focus-within:border-ring focus-within:ring-ring/24 rounded-lg border px-2.5 py-2 focus-within:ring-3">
        <EditorContent editor={editor} />
      </div>
      <p className="text-muted-foreground text-xs">
        {t("chat.editMessageNotice")}
      </p>
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
  const [draft, setDraft] = useState<UserMessageEditDraft | null>(null);

  if (actions === undefined || message.role !== "user") {
    return { editing: false, editor: null };
  }

  if (draft !== null) {
    const submitEdit = async (
      edit: UserMessageEdit,
    ): Promise<UserMessageEditOutcome> => {
      const outcome = await actions.onSubmit(message.id, edit);
      // The sent copy takes this message's id and place once the server
      // accepted it; until then, and after any refusal, the form stays open
      // on the draft.
      if (outcome.type === "accepted") {
        setDraft(null);
      }
      return outcome;
    };
    return {
      editing: true,
      editor: (
        <UserMessageEditForm
          draft={draft}
          isGenerating={isGenerating}
          onCancel={() => {
            setDraft(null);
          }}
          onHold={() => actions.holdQueue(message.id)}
          onSubmit={submitEdit}
        />
      ),
    };
  }

  return {
    editing: false,
    editor: (
      // Shown on hover of the message (the `group` of `Message`), on focus and
      // on touch; hidden while the sticky layout pins the message as a
      // compact header.
      <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 group-data-[stuck=true]/sticky:hidden focus-within:opacity-100 pointer-coarse:opacity-100">
        <Button
          aria-label={t("chat.editMessage")}
          onClick={() => {
            actions.onStart();
            setDraft(createUserMessageEditDraft(message, createUuid));
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

/** A sent user message body with its edit action below it. */
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
