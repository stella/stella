import { panic } from "better-result";

import {
  CHAT_SKILL_CONTEXT_NEED,
  CHAT_SKILL_DOCUMENT,
  type ChatEditApplyMode,
  type ChatSkillContextNeed,
} from "@stll/api-contract";

import type { SlashItem } from "@/components/chat/prompt-slash-extension";
import type { ActiveDocxEditModeState } from "@/lib/chat-edit-mode";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { toSafeId, type SafeId } from "@/lib/safe-id";

/** The document a composer has open, as its next send carries it. */
type ComposerSkillDocument =
  | {
      kind: typeof CHAT_SKILL_DOCUMENT.file;
      entityId: string;
      fileFieldId?: string | undefined;
    }
  | { kind: typeof CHAT_SKILL_DOCUMENT.draft }
  | { kind: typeof CHAT_SKILL_DOCUMENT.template };

/**
 * The chat a composer's skill menu answers for: the inputs its next send
 * carries that decide which tools the chat has. The send mode and the
 * browser extension are read live from their own stores.
 */
export type ComposerSkillChatContext = {
  /** The matters the next send draws from (its `contextMatterIds`). */
  contextMatterIds?: readonly string[] | undefined;
  document: ComposerSkillDocument | null;
  /** The edit mode the next send carries; absent, the send's default. */
  editApplyMode?: ChatEditApplyMode | undefined;
  /** Sets the open document's edits to manual review, where it can. */
  onReviewEdits?: (() => void) | undefined;
  threadRef: ChatThreadRef;
  /** The thread's web search, or `null` while the thread is loading. */
  webSearch: { available: boolean; enabled: boolean } | null;
};

/**
 * The file overlay's document and edit mode as its next send carries them:
 * a draft is sent as a draft; a file counts as an open document only while
 * its edit mode is available (otherwise the send marks it as not accepting
 * edits); and the edit mode is sent only while it is.
 */
export const fileOverlaySkillDocument = ({
  activeFile,
  editMode,
  hasActiveDraft,
}: {
  activeFile:
    | { entityId: string; fileFieldId?: string | undefined }
    | undefined;
  editMode: ActiveDocxEditModeState;
  hasActiveDraft: boolean;
}): Pick<ComposerSkillChatContext, "document" | "editApplyMode"> => {
  const editApplyMode =
    editMode.type === "unavailable"
      ? undefined
      : editMode.selection.editApplyMode;
  if (hasActiveDraft) {
    return { document: { kind: CHAT_SKILL_DOCUMENT.draft }, editApplyMode };
  }
  if (activeFile === undefined || editMode.type === "unavailable") {
    return { document: null, editApplyMode };
  }
  return {
    document: {
      entityId: activeFile.entityId,
      fileFieldId: activeFile.fileFieldId,
      kind: CHAT_SKILL_DOCUMENT.file,
    },
    editApplyMode,
  };
};

/** The availability endpoint's query for one composer's chat. */
export type ChatSkillAvailabilityQuery = {
  anonymized: boolean;
  browserExtension: boolean;
  contextMatterIds?: SafeId<"workspace">[];
  document?: ComposerSkillDocument["kind"];
  documentId?: SafeId<"entity">;
  editApplyMode?: ChatEditApplyMode;
  fileFieldId?: SafeId<"field">;
  webSearch: boolean;
  workspaceId?: SafeId<"workspace">;
};

/**
 * The query for `chat`, with the send mode and extension read live; `null`
 * while the chat is not known yet (its web search still loading), so the
 * menu offers no skill it has not been told the chat can run.
 */
export const chatSkillAvailabilityQuery = ({
  anonymized,
  browserExtension,
  chat,
}: {
  anonymized: boolean;
  browserExtension: boolean;
  chat: ComposerSkillChatContext;
}): ChatSkillAvailabilityQuery | null => {
  if (chat.webSearch === null) {
    return null;
  }
  const { contextMatterIds = [], document, threadRef } = chat;
  return {
    anonymized,
    browserExtension,
    webSearch: chat.webSearch.enabled,
    ...(contextMatterIds.length === 0
      ? {}
      : {
          contextMatterIds: contextMatterIds
            .toSorted()
            .map((id) => toSafeId<"workspace">(id)),
        }),
    ...(chat.editApplyMode === undefined
      ? {}
      : { editApplyMode: chat.editApplyMode }),
    ...(document === null ? {} : { document: document.kind }),
    ...(document?.kind === CHAT_SKILL_DOCUMENT.file
      ? {
          documentId: toSafeId<"entity">(document.entityId),
          ...(document.fileFieldId === undefined
            ? {}
            : { fileFieldId: toSafeId<"field">(document.fileFieldId) }),
        }
      : {}),
    ...(threadRef.scope === "workspace"
      ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
      : {}),
  };
};

type AvailabilityResponse = {
  unavailable: readonly { skillId: string }[];
  unavailableHere: readonly {
    needs: readonly ChatSkillContextNeed[];
    skillId: string;
  }[];
};

/**
 * How a skill menu treats the caller's skills: `hidden` ones no chat can
 * run stay out; `blockedHere` ones show disabled with what this chat lacks.
 * `undefined` until the server has answered.
 */
export type ChatSkillMenuAvailability =
  | {
      blockedHere: ReadonlyMap<string, readonly ChatSkillContextNeed[]>;
      hidden: ReadonlySet<string>;
    }
  | undefined;

export const chatSkillMenuAvailability = (
  data: AvailabilityResponse | undefined,
): ChatSkillMenuAvailability =>
  data === undefined
    ? undefined
    : {
        blockedHere: new Map(
          data.unavailableHere.map(({ needs, skillId }) => [skillId, needs]),
        ),
        hidden: new Set(data.unavailable.map(({ skillId }) => skillId)),
      };

/** The line a disabled skill row shows for the first thing it needs. */
export const CHAT_SKILL_NEED_MESSAGE_KEY = {
  [CHAT_SKILL_CONTEXT_NEED.browserExtension]:
    "chat.composerMenu.skillNeeds.browserExtension",
  [CHAT_SKILL_CONTEXT_NEED.document]: "chat.composerMenu.skillNeeds.document",
  [CHAT_SKILL_CONTEXT_NEED.matter]: "chat.composerMenu.skillNeeds.matter",
  [CHAT_SKILL_CONTEXT_NEED.rawSendMode]:
    "chat.composerMenu.skillNeeds.rawSendMode",
  [CHAT_SKILL_CONTEXT_NEED.reviewEdits]:
    "chat.composerMenu.skillNeeds.reviewEdits",
  [CHAT_SKILL_CONTEXT_NEED.webSearch]: "chat.composerMenu.skillNeeds.webSearch",
} as const satisfies Record<ChatSkillContextNeed, string>;

/**
 * The needs this composer can meet in one click: turning web search on where
 * the organization offers it, and queueing an open document's edits for
 * review where the composer has an edit-mode switch.
 */
export const oneClickSkillNeeds = (
  chat: ComposerSkillChatContext | undefined,
): ReadonlySet<ChatSkillContextNeed> =>
  new Set([
    ...(chat?.webSearch?.available === true
      ? [CHAT_SKILL_CONTEXT_NEED.webSearch]
      : []),
    ...(chat?.onReviewEdits === undefined
      ? []
      : [CHAT_SKILL_CONTEXT_NEED.reviewEdits]),
  ]);

/**
 * How a skill row reads in this chat: offered, or blocked with the need to
 * explain (the first the server named). A blocked row is fixable in one
 * click when that need is its only one and this composer can meet it.
 */
export type ChatSkillRowState =
  | { status: "offered" }
  | {
      fixable: boolean;
      messageKey: (typeof CHAT_SKILL_NEED_MESSAGE_KEY)[ChatSkillContextNeed];
      need: ChatSkillContextNeed;
      status: "blocked";
    };

const OFFERED: ChatSkillRowState = { status: "offered" };

export const chatSkillRowState = ({
  availability,
  oneClickNeeds,
  skillId,
}: {
  availability: ChatSkillMenuAvailability;
  oneClickNeeds: ReadonlySet<ChatSkillContextNeed>;
  skillId: string | null;
}): ChatSkillRowState => {
  const needs =
    skillId === null ? undefined : availability?.blockedHere.get(skillId);
  if (needs === undefined) {
    return OFFERED;
  }
  const [need] = needs;
  if (need === undefined) {
    return OFFERED;
  }
  return {
    fixable: needs.length === 1 && oneClickNeeds.has(need),
    messageKey: CHAT_SKILL_NEED_MESSAGE_KEY[need],
    need,
    status: "blocked",
  };
};

/** The skill a slash item inserts, or `null` for a reserved command. */
export const slashItemSkillId = (item: SlashItem): string | null => {
  switch (item.kind) {
    case "command":
      return null;
    case "prompt":
      return item.prompt.id;
    case "skill":
      return item.skill.id;
    default:
      item satisfies never;
      return panic("Unhandled slash item kind");
  }
};

/** Stable query-key part for one chat's availability. */
export const chatSkillAvailabilityKey = (
  query: ChatSkillAvailabilityQuery | undefined,
): readonly unknown[] =>
  query === undefined
    ? ["widest"]
    : [
        "chat",
        query.anonymized,
        query.browserExtension,
        query.webSearch,
        query.contextMatterIds ?? null,
        query.document ?? null,
        query.documentId ?? null,
        query.editApplyMode ?? null,
        query.fileFieldId ?? null,
        query.workspaceId ?? null,
      ];
