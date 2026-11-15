import type { JSONContent } from "@tiptap/react";

import { CHAT_MESSAGE_EDIT_ERROR_CODE } from "@stll/api-contract";
import type { ChatMessageEditErrorCode } from "@stll/api-contract";
import { isChatPastedTextPart } from "@stll/api-contract/chat";
import type { ChatPastedTextPart } from "@stll/api-contract/chat";

import { userMessageComposerContent } from "@/components/chat-editor-markdown.logic";
import type {
  ChatAttachmentPart,
  ChatPart,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { CHAT_REQUEST_ERROR_TRANSLATION_KEYS } from "@/features/chat/chat-request-error";
import type { ChatRequestError } from "@/features/chat/chat-request-error";
import type { ChatUserMessageInput } from "@/features/chat/chat-runtime";
import type { TranslationKey } from "@/i18n/types";
import { STATUS_ERROR_KEYS, STATUS_TO_KEY } from "@/lib/errors/localization";
import type { StatusErrorKey } from "@/lib/errors/localization";
import { toSafeId } from "@/lib/safe-id";

export type UserMessageEditAttachmentPart =
  ChatAttachmentPart | ChatPastedTextPart;

/** An attachment of the edited message, under an id for this edit session. */
export type UserMessageEditAttachment = {
  id: string;
  part: UserMessageEditAttachmentPart;
};

/** What the edit form opens with: the message's text as composer content,
 *  and its attachments. */
export type UserMessageEditDraft = {
  attachments: readonly UserMessageEditAttachment[];
  content: JSONContent | string;
};

/** What sending an edit carries: the composer's markup, as a new message
 *  carries it, and the attachments the user kept. */
export type UserMessageEdit = {
  attachments: readonly UserMessageEditAttachmentPart[];
  html: string;
};

/**
 * How sending an edit ended. Only `accepted` closes the form: every other
 * outcome leaves it open on the user's draft, over the thread as the server
 * stores it.
 * - `accepted`: the server took the edit's turn, which now answers it.
 * - `edit-refused`: the server refused the edit itself (`code`); a message
 *   the page no longer holds reads as `targetMissing`.
 * - `request-refused`: the server refused the request for another reason,
 *   such as a lapsed session, a missing permission or invalid input.
 * - `ai-unavailable`: no AI model is available, so nothing was sent.
 * - `request-failed`: the request did not reach the server or was not
 *   started (`kind`), such as a lost connection.
 * - `failed`: the request failed in a way none of the above names.
 */
export type UserMessageEditOutcome =
  | { type: "accepted" }
  | { type: "edit-refused"; code: ChatMessageEditErrorCode }
  | { type: "request-refused"; status: number }
  | { type: "ai-unavailable" }
  | { type: "request-failed"; kind: ChatRequestError["kind"] }
  | { type: "failed" };

export type UserMessageEditFailure = Exclude<
  UserMessageEditOutcome,
  { type: "accepted" }
>;

/**
 * One opening of a sent message's edit form. An edit's work goes on after
 * its form may have closed: the request, the server's answer. Every
 * continuation that acts on the form, its draft, the composer or the queue
 * hold goes through `run`, which does nothing once the session is no longer
 * its message's current one, so a late answer to a cancelled edit never
 * closes, fills or notifies over a newer edit of the same message. What the
 * server did, and the thread the page reloads from it, are not
 * continuations of a session and always apply.
 */
export type UserMessageEditSession = {
  /** Keys the session's queue hold and its form. */
  readonly id: string;
  run: (continuation: () => void) => void;
  /** Keep the session's copy of the form's current draft; read only when
   *  the session's message leaves the thread. */
  mirror: (edit: UserMessageEdit) => void;
};

/** A session as its message holds it: `end` retires it (the form closed). */
export type OpenUserMessageEditSession = UserMessageEditSession & {
  end: () => void;
};

type TrackedSession = {
  draft: UserMessageEdit | null;
  id: string;
  /** Requests of this session the server has yet to answer. */
  sending: number;
};

/**
 * The open edits of a thread's sent messages, one current session per
 * message. Opening a session for a message retires the one before; ending
 * it leaves none. It is also the one owner of what happens when an edited
 * message leaves the thread, whatever removed it: `takeOrphans` ends every
 * current session whose message the thread no longer holds and hands back
 * its latest draft. A session with a request out is left alone until the
 * server answered it (`whileSending`), since the page shows a rewound
 * thread meanwhile.
 */
export const createUserMessageEditSessions = (createId: () => string) => {
  const current = new Map<string, TrackedSession>();
  const isCurrent = (messageId: string, id: string) =>
    current.get(messageId)?.id === id;
  return {
    open: (messageId: string): OpenUserMessageEditSession => {
      const tracked: TrackedSession = {
        draft: null,
        id: createId(),
        sending: 0,
      };
      current.set(messageId, tracked);
      const { id } = tracked;
      return {
        end: () => {
          if (isCurrent(messageId, id)) {
            current.delete(messageId);
          }
        },
        id,
        mirror: (edit) => {
          tracked.draft = edit;
        },
        run: (continuation) => {
          if (isCurrent(messageId, id)) {
            continuation();
          }
        },
      };
    },
    /** Ends and returns every current session (its last draft) whose
     *  message is not in `messageIds` and has no request out. */
    takeOrphans: (messageIds: ReadonlySet<string>): UserMessageEdit[] => {
      const orphans: UserMessageEdit[] = [];
      for (const [messageId, tracked] of current) {
        if (messageIds.has(messageId) || tracked.sending > 0) {
          continue;
        }
        current.delete(messageId);
        if (tracked.draft !== null) {
          orphans.push(tracked.draft);
        }
      }
      return orphans;
    },
    hasOpen: (): boolean => current.size > 0,
    /** Runs `request` for `session`, holding its orphan check until the
     *  server answered. */
    whileSending: async <T>(
      session: UserMessageEditSession,
      request: () => Promise<T>,
    ): Promise<T> => {
      const tracked = [...current.values()].find(({ id }) => id === session.id);
      if (tracked !== undefined) {
        tracked.sending += 1;
      }
      try {
        return await request();
      } finally {
        if (tracked !== undefined) {
          tracked.sending -= 1;
        }
      }
    },
  };
};

/**
 * An orphaned edit, split by what the composer can take back. Its markup and
 * pasted texts go into the composer. Its kept documents and images are files
 * the server already stores, and the composer holds only files picked on this
 * device, so they cannot follow; `storedFiles` lists each by its file name
 * (undefined when it has none) for the notice to name.
 */
export const userMessageEditHandoff = (
  edit: UserMessageEdit,
): {
  composer: { html: string; pastedTexts: string[] };
  storedFiles: (string | undefined)[];
} => {
  const pastedTexts: string[] = [];
  const storedFiles: (string | undefined)[] = [];
  for (const part of edit.attachments) {
    if (isChatPastedTextPart(part)) {
      pastedTexts.push(part.content);
    } else {
      storedFiles.push(part.metadata?.filename);
    }
  }
  return { composer: { html: edit.html, pastedTexts }, storedFiles };
};

/** The notice for each code the server refuses an edit with. */
const EDIT_REFUSAL_NOTICE_KEYS = {
  [CHAT_MESSAGE_EDIT_ERROR_CODE.historyChanged]:
    "chat.editMessageRefusedHistoryChanged",
  [CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing]:
    "chat.editMessageRefusedTargetMissing",
  [CHAT_MESSAGE_EDIT_ERROR_CODE.targetNotUserMessage]:
    "chat.editMessageRefusedTargetMissing",
  [CHAT_MESSAGE_EDIT_ERROR_CODE.turnRunning]: "chat.editMessageRefused",
} as const satisfies Record<ChatMessageEditErrorCode, TranslationKey>;

type UserMessageEditNoticeKey =
  | (typeof EDIT_REFUSAL_NOTICE_KEYS)[ChatMessageEditErrorCode]
  | StatusErrorKey
  | (typeof CHAT_REQUEST_ERROR_TRANSLATION_KEYS)[ChatRequestError["kind"]]
  | "chat.editMessageAiUnavailable"
  | "chat.sendError";

/** What the open edit form tells the user about an edit that was not
 *  accepted: one notice for every outcome, decided by an exhaustive
 *  switch. */
export const userMessageEditNoticeKey = (
  failure: UserMessageEditFailure,
): UserMessageEditNoticeKey => {
  let key: UserMessageEditNoticeKey;
  switch (failure.type) {
    case "edit-refused":
      key = EDIT_REFUSAL_NOTICE_KEYS[failure.code];
      break;
    case "request-refused":
      key = STATUS_TO_KEY[failure.status] ?? STATUS_ERROR_KEYS.unknown;
      break;
    case "ai-unavailable":
      key = "chat.editMessageAiUnavailable";
      break;
    case "request-failed":
      key = CHAT_REQUEST_ERROR_TRANSLATION_KEYS[failure.kind];
      break;
    case "failed":
      key = "chat.sendError";
      break;
  }
  return key;
};

const isEditAttachmentPart = (
  part: ChatPart,
): part is UserMessageEditAttachmentPart =>
  part.type === "image" ||
  part.type === "document" ||
  isChatPastedTextPart(part);

/** The edit form's starting state for a sent user message. */
export const createUserMessageEditDraft = (
  message: Pick<PersistedChatMessage, "parts">,
  createId: () => string,
): UserMessageEditDraft => {
  const texts: string[] = [];
  const attachments: UserMessageEditAttachment[] = [];
  for (const part of message.parts) {
    if (isEditAttachmentPart(part)) {
      attachments.push({ id: createId(), part });
    } else if (part.type === "text") {
      texts.push(part.content);
    }
  }
  return {
    attachments,
    // The composer sends one text part; its parts read as one document.
    content: userMessageComposerContent(texts.join("\n\n")),
  };
};

/** Whether the edit would send anything: text or a kept attachment. */
export const hasUserMessageEditContent = (edit: UserMessageEdit): boolean =>
  edit.html.length > 0 || edit.attachments.length > 0;

/**
 * The message the edit sends: the same id as the message it replaces, and
 * the content a new message from the composer would carry.
 */
export const buildEditedUserMessage = ({
  edit,
  messageId,
}: {
  edit: UserMessageEdit;
  messageId: string;
}): ChatUserMessageInput => {
  const id = toSafeId<"chatMessage">(messageId);
  const attachments = [...edit.attachments];
  if (attachments.length === 0) {
    return { id, content: edit.html };
  }
  if (edit.html.length === 0) {
    return { id, content: attachments };
  }
  return {
    id,
    content: [
      { type: "text", content: edit.html } satisfies ChatPart,
      ...attachments,
    ],
  };
};
