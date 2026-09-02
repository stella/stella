import type { ChatSendMode } from "@stll/anonymize-chat";
import {
  CHAT_TOOL_SCOPE,
  type DocxSuggestionSurface,
} from "@stll/api-contract";

import type { ChatUserContext } from "@/features/chat/hooks/use-chat-user-context";
import type {
  ChatEditApplyMode,
  DocxEditRepresentation,
} from "@/lib/chat-edit-mode";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import type { QueryOptionsInput } from "@/lib/react-query";

type ActiveFileContext = {
  docxEditSnapshot?:
    | {
        blocks: {
          /** Folio's normalized text hash; the model echoes it as an edit precondition. */
          blockTextHash?: string | undefined;
          displayLabel?: string | undefined;
          id: string;
          kind: "heading" | "listItem" | "paragraph";
          styleId?: string | undefined;
          text: string;
        }[];
        canApplyEdits?: boolean | undefined;
      }
    | undefined;
  entityId: string;
  fileFieldId?: string | undefined;
  fileName: string;
  supportsDocxEdits?: boolean | undefined;
};

type ActiveDraftContext = {
  docxEditSnapshot: NonNullable<ActiveFileContext["docxEditSnapshot"]>;
  fileName: string;
  originChatMessageId: string;
  originChatThreadId: string;
  toolCallId: string;
};

type ActiveTemplateContext = {
  docxEditSnapshot?: ActiveFileContext["docxEditSnapshot"];
  fileName: string;
  templateId: string;
};

type ActiveDecisionContext = {
  decisionId: string;
};

type ActiveExternalContext = {
  connectorSlug?: string | undefined;
  provider?: string | undefined;
  snippet?: string | undefined;
  sourceToolName?: string | undefined;
  text?: string | undefined;
  title: string;
  url: string;
};

export type ActiveSkillContext = {
  skillId?: string | undefined;
  skillName: string;
};

export type ChatThreadKey = ChatThreadRef;

export type FileChatThreadKey = {
  entityId: string;
  fieldId: string;
  workspaceId: string;
};

export type TemplateChatThreadKey = {
  templateId: string;
};

export type ChatThreadTitleKey = {
  threadId: string;
  workspaceId?: string | undefined;
};

export type GroupedChatThreadsKey = {
  activeOrganizationId: string;
  search?: string | undefined;
};

export const SUGGEST_TEMPLATE_FIELDS_TOOL_SCOPE =
  CHAT_TOOL_SCOPE.suggestTemplateFields;

export type ChatThreadOptionsContext = {
  allowMissingThread?: boolean | undefined;
  getActiveDecision?: (() => ActiveDecisionContext | undefined) | undefined;
  getActiveDraft?: (() => ActiveDraftContext) | undefined;
  getActiveExternal?: (() => ActiveExternalContext | undefined) | undefined;
  getActiveFile?: (() => ActiveFileContext | undefined) | undefined;
  getActiveSkill?: (() => ActiveSkillContext | undefined) | undefined;
  getActiveTemplate?: (() => ActiveTemplateContext | undefined) | undefined;
  getContextMatterIds?: (() => string[]) | undefined;
  getEditApplyMode?: (() => ChatEditApplyMode) | undefined;
  getDocxEditRepresentation?:
    | (() => DocxEditRepresentation | undefined)
    | undefined;
  getSendMode?: (() => ChatSendMode) | undefined;
  getUserContext?: (() => ChatUserContext) | undefined;
  /**
   * Present on a surface that mounts a `suggest_changes` review-queue
   * bridge (the file overlay). Its presence, not its value, keys the
   * thread cache as "active-docx-edit"; see `getChatRuntimeContextKind`.
   */
  getDocxSuggestionSurface?: (() => DocxSuggestionSurface) | undefined;
};

export type ChatRuntimeContextKind =
  | "active-docx-edit"
  | "active-external"
  | "active-file"
  | "active-skill"
  | "active-template"
  | "plain";

type ChatThreadQueryKey = ChatThreadRef & {
  allowMissingThread?: boolean | undefined;
  contextKind?: ChatRuntimeContextKind | undefined;
};

export const getChatRuntimeContextKind = (
  context: ChatThreadOptionsContext | undefined,
): ChatRuntimeContextKind => {
  if (context?.getDocxSuggestionSurface) {
    return "active-docx-edit";
  }
  if (context?.getActiveFile) {
    return "active-file";
  }
  if (context?.getActiveDraft) {
    return "active-docx-edit";
  }
  if (context?.getActiveExternal) {
    return "active-external";
  }
  if (context?.getActiveSkill) {
    return "active-skill";
  }
  if (context?.getActiveTemplate) {
    return "active-template";
  }
  return "plain";
};

const CHAT_TRANSPORT_VERSION = 2;

export const chatKeys = {
  all: ["chat"],
  fileThread: (activeOrganizationId: string, key: FileChatThreadKey) => [
    ...chatKeys.all,
    activeOrganizationId,
    "file-thread",
    key.workspaceId,
    key.entityId,
    key.fieldId,
  ],
  templateThread: (
    activeOrganizationId: string,
    key: TemplateChatThreadKey,
  ) => [
    ...chatKeys.all,
    activeOrganizationId,
    "template-thread",
    key.templateId,
  ],
  groupedThreads: ({ activeOrganizationId, search }: GroupedChatThreadsKey) => [
    ...chatKeys.all,
    activeOrganizationId,
    "threads",
    "grouped",
    search ?? "",
  ],
  modelOptions: (activeOrganizationId: string) => [
    ...chatKeys.all,
    activeOrganizationId,
    "modelOptions",
  ],
  threadTitle: (activeOrganizationId: string, key: ChatThreadTitleKey) => [
    ...chatKeys.all,
    activeOrganizationId,
    "thread-title",
    key.workspaceId ?? "global",
    key.threadId,
  ],
  threadPrefix: (activeOrganizationId: string, threadRef: ChatThreadRef) =>
    threadRef.scope === "global"
      ? [
          ...chatKeys.all,
          activeOrganizationId,
          "thread",
          threadRef.scope,
          threadRef.threadId,
        ]
      : [
          ...chatKeys.all,
          activeOrganizationId,
          "thread",
          threadRef.scope,
          threadRef.workspaceId,
          threadRef.threadId,
        ],
  thread: (activeOrganizationId: string, key: ChatThreadQueryKey) => [
    ...chatKeys.threadPrefix(activeOrganizationId, key),
    key.allowMissingThread ?? false,
    key.contextKind ?? "plain",
    CHAT_TRANSPORT_VERSION,
  ],
  draftMeta: (activeOrganizationId: string, threadRef: ChatThreadRef) => [
    ...chatKeys.threadPrefix(activeOrganizationId, threadRef),
    "draftMeta",
  ],
  recap: (
    activeOrganizationId: string,
    threadRef: ChatThreadRef,
    lastMessageId: string,
  ) => [
    ...chatKeys.threadPrefix(activeOrganizationId, threadRef),
    "recap",
    lastMessageId,
  ],
  suggestedPrompts: (
    activeOrganizationId: string,
    threadRef: ChatThreadRef,
    lastMessageId: string,
  ) => [
    ...chatKeys.threadPrefix(activeOrganizationId, threadRef),
    "suggestedPrompts",
    lastMessageId,
  ],
};

export type ChatThreadOptionsInput = QueryOptionsInput<
  ChatThreadKey,
  ChatThreadOptionsContext
>;

export type { ActiveFileContext };
