import { useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { isChatPastedTextPart } from "@stll/api-contract/chat";
import { Button } from "@stll/ui/button";
import { PencilIcon, TextIcon, XIcon } from "@stll/ui/icons";
import { Textarea } from "@stll/ui/textarea";

import { AttachmentChip } from "@/components/chat/attachment-chip";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import {
  createUserMessageEditDraft,
  hasUserMessageEditContent,
} from "@/components/chat/user-message-edit.logic";
import type {
  UserMessageEditAttachment,
  UserMessageEditDraft,
} from "@/components/chat/user-message-edit.logic";
import { DocumentIcon } from "@/components/document-icon";
import { useMountEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import { createUuid } from "@/lib/uuid";

/** What a transcript does when the user edits one of their sent messages. */
export type UserMessageEditActions = {
  /** The editor opened; a running turn is stopped first. */
  onStart: () => void;
  /** Replace the message with the draft and run the assistant again. */
  onSubmit: (messageId: string, draft: UserMessageEditDraft) => Promise<void>;
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

type UserMessageEditFormProps = {
  draft: UserMessageEditDraft;
  isGenerating: boolean;
  onCancel: () => void;
  onChange: (draft: UserMessageEditDraft) => void;
  onSubmit: () => void;
};

const UserMessageEditForm = ({
  draft,
  isGenerating,
  onCancel,
  onChange,
  onSubmit,
}: UserMessageEditFormProps) => {
  const t = useTranslations();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useMountEffect(() => {
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  const canSend = hasUserMessageEditContent(draft) && !isGenerating;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (canSend) {
        onSubmit();
      }
    }
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-2" data-chat-message-edit>
      {draft.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {draft.attachments.map((attachment) => {
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
                      onChange({
                        ...draft,
                        attachments: draft.attachments.filter(
                          (candidate) => candidate.id !== attachment.id,
                        ),
                      });
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
      <Textarea
        aria-label={t("chat.editMessageInput")}
        onChange={(event) => {
          onChange({ ...draft, text: event.currentTarget.value });
        }}
        onKeyDown={handleKeyDown}
        ref={textareaRef}
        value={draft.text}
      />
      <p className="text-muted-foreground text-xs">
        {t("chat.editMessageNotice")}
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" variant="ghost">
          {t("common.cancel")}
        </Button>
        <Button disabled={!canSend} onClick={onSubmit} size="sm">
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
 * editing the form that holds the message's text and attachments, shown in
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
          onChange={setDraft}
          onSubmit={() => {
            // The sent copy takes this message's id and place, so the form
            // closes now rather than staying open over it.
            setDraft(null);
            detached(
              actions.onSubmit(message.id, draft),
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
