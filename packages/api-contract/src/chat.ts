import type { Brand } from "valibot";

import type { ChatSendMode } from "@stll/anonymize-chat";

export const CHAT_TOOL_SCOPE = {
  suggestTemplateFields: "suggest-template-fields",
} as const;

export const CHAT_TURN_INTENT = {
  regenerate: "regenerate",
} as const;

export const CHAT_RUN_MODE = { agent: "agent" } as const;
export type ChatRunMode = (typeof CHAT_RUN_MODE)[keyof typeof CHAT_RUN_MODE];

export type SafeId<TType extends string> = string &
  Brand<"SafeId"> & {
    readonly __safeIdType?: TType;
  };

type DocxEditSnapshot = {
  canApplyEdits?: boolean;
  blocks: {
    displayLabel?: string;
    id: string;
    kind: "heading" | "listItem" | "paragraph";
    styleId?: string;
    text: string;
  }[];
};

export type ChatInterruptResolution =
  | {
      interruptId: string;
      payload?: unknown;
      status: "resolved";
    }
  | {
      interruptId: string;
      payload?: never;
      status: "cancelled";
    };

type ChatSendMessage = {
  id: SafeId<"chatMessage">;
  metadata?: unknown;
  parts: unknown[];
  role: "assistant" | "system" | "user";
};

type ChatInitialTurn = {
  message: ChatSendMessage;
  parentRunId?: never;
  resume?: never;
};

type ChatNativeContinuation = {
  message: ChatSendMessage & { role: "assistant" };
  /** The interrupted AG-UI run this continuation resolves. */
  parentRunId: string;
  /** Complete, all-or-nothing AG-UI interrupt resolution batch. */
  resume: ChatInterruptResolution[];
};

export type ChatContinuation = ChatInitialTurn | ChatNativeContinuation;

/** Portable projection of the Elysia chat-stream request schema. */
type ChatSendRequestBase = {
  activeDecision?: {
    decisionId: SafeId<"caseLawDecision">;
  };
  activeExternal?: {
    connectorSlug?: string;
    provider?: string;
    snippet?: string;
    sourceToolName?: string;
    text?: string;
    title: string;
    url: string;
  };
  activeDraft?: {
    docxEditSnapshot: DocxEditSnapshot;
    fileName: string;
    originChatMessageId: SafeId<"chatMessage">;
    originChatThreadId: SafeId<"chatThread">;
    toolCallId: string;
  };
  activeFile?: {
    docxEditSnapshot?: DocxEditSnapshot;
    entityId: SafeId<"entity">;
    fileFieldId?: SafeId<"field">;
    fileName: string;
    supportsDocxEdits?: boolean;
  };
  activeSkill?: {
    skillId?: SafeId<"agentSkill">;
    skillName: string;
  };
  activeTemplate?: {
    docxEditSnapshot?: DocxEditSnapshot;
    fileName: string;
    templateId: SafeId<"template">;
  };
  contextMatterIds?: SafeId<"workspace">[];
  devModelId?: string;
  docxEditRepresentation?: "tracked-changes" | "direct";
  editApplyMode?: "manual" | "auto";
  runMode?: ChatRunMode;
  /** AG-UI run correlation minted by TanStack ChatClient. */
  runId: string;
  sendMode: ChatSendMode;
  threadId: SafeId<"chatThread">;
  turnIntent?: (typeof CHAT_TURN_INTENT)["regenerate"];
  toolScope?: (typeof CHAT_TOOL_SCOPE)["suggestTemplateFields"];
  truncateAfterMessageId?: SafeId<"chatMessage">;
  userContext?: {
    locale: string;
    timezone: string;
    userName: string;
    wordEditAuthorName?: string;
    wordEditShortcut?: string;
  };
  workspaceId?: SafeId<"workspace">;
};

export type ChatSendRequest =
  | (ChatSendRequestBase & ChatInitialTurn)
  | (ChatSendRequestBase & ChatNativeContinuation);
