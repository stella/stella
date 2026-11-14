import type { ChatSendMode } from "@stll/anonymize-chat";
import { CHAT_TOOL_SCOPE } from "@stll/api-contract";
import type { ChatThreadPinState } from "@stll/api-contract/chat";
import type { DocxSuggestionSurface } from "@stll/api-contract/chat-docx-suggestions";
import type { ChatRunTarget } from "@stll/api-contract/chat-run-target";

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
        blocks: readonly {
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

/**
 * The statute consolidation the reader has open. Only the id travels: the
 * act's identity, its wording and the reader's marks on it are resolved
 * server-side from the corpus.
 */
type ActiveStatuteContext = {
  documentId: string;
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

type ActiveSkillContext = {
  /** Absent for a built-in skill, which has no row: `skillName` names it. */
  skillId?: string | undefined;
  skillName: string;
};

export type ChatThreadKey = ChatThreadRef;

export type FileChatThreadKey = {
  entityId: string;
  fieldId: string;
  userId: string;
  workspaceId: string;
};

export type TemplateChatThreadKey = {
  templateId: string;
  userId: string;
};

/** A reader's one conversation about a case-law decision. */
export type DecisionChatThreadKey = {
  decisionId: string;
  userId: string;
};

export type ChatThreadTitleKey = {
  threadId: string;
  workspaceId?: string | undefined;
};

export type GroupedChatThreadsKey = {
  activeOrganizationId: string;
  /** Only the reader's pinned, or only their unpinned, threads. */
  pinState?: ChatThreadPinState | undefined;
  search?: string | undefined;
  userId: string;
  /** Only the threads that live in this matter. */
  workspaceId?: string | undefined;
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
  getActiveStatute?: (() => ActiveStatuteContext | undefined) | undefined;
  getActiveTemplate?: (() => ActiveTemplateContext | undefined) | undefined;
  getContextMatterIds?: (() => string[]) | undefined;
  getEditApplyMode?: (() => ChatEditApplyMode) | undefined;
  getDocxEditRepresentation?:
    (() => DocxEditRepresentation | undefined) | undefined;
  getSendMode?: (() => ChatSendMode) | undefined;
  getUserContext?: (() => ChatUserContext) | undefined;
  /** Where the next turn runs; absent on surfaces that only run in the cloud. */
  getRunTarget?: (() => ChatRunTarget) | undefined;
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
  | "active-template"
  | "plain";

type ChatThreadQueryKey = ChatThreadRef & {
  allowMissingThread?: boolean | undefined;
  contextKind?: ChatRuntimeContextKind | undefined;
};

/**
 * A chat's skill never selects a kind: the thread response itself
 * restores it (`activeSkill`), so a surface learns the skill only after
 * reading the thread. Keying by it would read the thread under one key
 * and run its runtime under another.
 */
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
  if (context?.getActiveTemplate) {
    return "active-template";
  }
  return "plain";
};

const CHAT_TRANSPORT_VERSION = 2;

/** Bump when `GET /chat/model-options` changes shape so cached rows refetch. */
const MODEL_OPTIONS_RESPONSE_VERSION = 2;

type AnswerRevisionQueryKey = {
  activeOrganizationId: string;
  userId: string;
  threadId: string;
  messageId: string;
  revision: number;
};

export const chatKeys = {
  all: ["chat"],
  /** The reader's own chats that are working or waiting on them, all matters. */
  activeRuns: (activeOrganizationId: string, userId: string) => [
    ...chatKeys.all,
    activeOrganizationId,
    userId,
    "runs",
    "active",
  ],
  fileThread: (activeOrganizationId: string, key: FileChatThreadKey) => [
    ...chatKeys.all,
    activeOrganizationId,
    key.userId,
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
    key.userId,
    "template-thread",
    key.templateId,
  ],
  decisionThread: (
    activeOrganizationId: string,
    key: DecisionChatThreadKey,
  ) => [
    ...chatKeys.all,
    activeOrganizationId,
    key.userId,
    "decision-thread",
    key.decisionId,
  ],
  /** Every grouped thread list of the reader, whatever its filters. */
  groupedThreadLists: (activeOrganizationId: string, userId: string) => [
    ...chatKeys.all,
    activeOrganizationId,
    userId,
    "threads",
    "grouped",
  ],
  groupedThreads: ({
    activeOrganizationId,
    pinState,
    search,
    userId,
    workspaceId,
  }: GroupedChatThreadsKey) => [
    ...chatKeys.groupedThreadLists(activeOrganizationId, userId),
    pinState ?? "",
    search ?? "",
    workspaceId ?? "",
  ],
  toolGrants: (
    activeOrganizationId: string,
    userId: string,
    threadId: string,
  ) => [...chatKeys.all, activeOrganizationId, userId, "tool-grants", threadId],
  limitReminder: (
    activeOrganizationId: string,
    userId: string,
    threadKey: string,
  ) => [
    ...chatKeys.all,
    activeOrganizationId,
    userId,
    "limit-reminder",
    threadKey,
  ],
  localFilesUndo: (
    activeOrganizationId: string,
    userId: string,
    threadId: string,
    turnId: string,
  ) => [
    ...chatKeys.all,
    activeOrganizationId,
    userId,
    "local-files-undo",
    threadId,
    turnId,
  ],
  /** Every chat's background count of the reader, for one refresh. */
  backgroundTaskCounts: (activeOrganizationId: string, userId: string) => [
    ...chatKeys.all,
    activeOrganizationId,
    userId,
    "background-tasks",
  ],
  backgroundTasks: (
    activeOrganizationId: string,
    userId: string,
    threadId: string,
  ) => [
    ...chatKeys.backgroundTaskCounts(activeOrganizationId, userId),
    threadId,
  ],
  localRunStepOutput: ({
    activeOrganizationId,
    userId,
    callId,
  }: {
    activeOrganizationId: string;
    userId: string;
    callId: string;
  }) => [
    ...chatKeys.all,
    activeOrganizationId,
    userId,
    "local-run-step-output",
    callId,
  ],
  /** An image a step viewed, read whole: another read than its text. */
  localRunStepImage: (key: {
    activeOrganizationId: string;
    userId: string;
    callId: string;
  }) => [...chatKeys.localRunStepOutput(key), "image"],
  browserSiteGrants: (activeOrganizationId: string, userId: string) => [
    ...chatKeys.all,
    activeOrganizationId,
    userId,
    "browser-site-grants",
  ],
  modelOptions: (activeOrganizationId: string) => [
    ...chatKeys.all,
    activeOrganizationId,
    "modelOptions",
    MODEL_OPTIONS_RESPONSE_VERSION,
  ],
  localRunners: (activeOrganizationId: string) => [
    ...chatKeys.all,
    activeOrganizationId,
    "localRunners",
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
  answerSnapshot: ({
    activeOrganizationId,
    userId,
    threadId,
    messageId,
    revision,
  }: AnswerRevisionQueryKey) => [
    ...chatKeys.all,
    activeOrganizationId,
    userId,
    "answer",
    threadId,
    messageId,
    revision,
  ],
  answerHistory: ({
    activeOrganizationId,
    userId,
    threadId,
    messageId,
    revision,
  }: AnswerRevisionQueryKey) => [
    ...chatKeys.answerSnapshot({
      activeOrganizationId,
      userId,
      threadId,
      messageId,
      revision,
    }),
    "history",
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
