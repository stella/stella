import { useState } from "react";
import type { ReactNode } from "react";

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions";
import type { EditorProps } from "@tiptap/pm/view";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { useTranslations } from "use-intl";

import { isChatPastedTextPart } from "@stll/api-contract/chat";
import { Button } from "@stll/ui/button";
import { PencilIcon, TextIcon, XIcon } from "@stll/ui/icons";

import {
  chatComposerHtml,
  createChatComposerSchemaExtensions,
} from "@/components/chat-composer-schema";
import { AttachmentChip } from "@/components/chat/attachment-chip";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import {
  createUserMessageEditDraft,
  hasUserMessageEditContent,
} from "@/components/chat/user-message-edit.logic";
import type {
  UserMessageEdit,
  UserMessageEditAttachment,
  UserMessageEditDraft,
} from "@/components/chat/user-message-edit.logic";
import { DocumentIcon } from "@/components/document-icon";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { detached } from "@/lib/detached";
import { createUuid } from "@/lib/uuid";

/** What a transcript does when the user edits one of their sent messages. */
export type UserMessageEditActions = {
  /** The editor opened; a running turn is stopped first. */
  onStart: () => void;
  /** Replace the message with the edit and run the assistant again. */
  onSubmit: (messageId: string, edit: UserMessageEdit) => Promise<void>;
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
  onSubmit: (edit: UserMessageEdit) => void;
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
  onSubmit,
}: UserMessageEditFormProps) => {
  const t = useTranslations();
  const [attachments, setAttachments] = useState(draft.attachments);
  // The editor outlives a render, so its handlers read the latest props.
  const submitFrom = useLatestCallback((current: Editor) => {
    const edit: UserMessageEdit = {
      attachments: attachments.map(({ part }) => part),
      html: chatComposerHtml(current),
    };
    if (hasUserMessageEditContent(edit) && !isGenerating) {
      onSubmit(edit);
    }
  });
  const cancel = useLatestCallback(() => {
    onCancel();
  });
  const [extensions] = useState(() => [
    ...createChatComposerSchemaExtensions(),
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
    // Like the composer, a paste never brings clipboard markup into the
    // message: it is inserted as the text it is.
    handlePaste: (view, event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text.length > 0) {
        view.dispatch(view.state.tr.insertText(text));
      }
      return true;
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
    selector: ({ editor: current }) =>
      current === null ? "" : chatComposerHtml(current),
  });
  const canSend =
    hasUserMessageEditContent({
      attachments: attachments.map(({ part }) => part),
      html: html ?? "",
    }) && !isGenerating;

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
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" variant="ghost">
          {t("common.cancel")}
        </Button>
        <Button
          disabled={!canSend}
          onClick={() => {
            if (editor !== null) {
              submitFrom(editor);
            }
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
}: UserMessageEditOptions): { editing: boolean; editor: ReactNode } => {
  const t = useTranslations();
  const [draft, setDraft] = useState<UserMessageEditDraft | null>(null);

  if (actions === undefined || message.role !== "user") {
    return { editing: false, editor: null };
  }

  if (draft !== null) {
    return {
      editing: true,
      editor: (
        <UserMessageEditForm
          draft={draft}
          isGenerating={isGenerating}
          onCancel={() => {
            setDraft(null);
          }}
          onSubmit={(edit) => {
            // The sent copy takes this message's id and place, so the form
            // closes now rather than staying open over it.
            setDraft(null);
            detached(
              actions.onSubmit(message.id, edit),
              "user-message-edit.submit",
            );
          }}
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
