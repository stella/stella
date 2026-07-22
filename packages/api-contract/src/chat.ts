import type { Brand } from "valibot";

import type { ChatSendMode } from "@stll/anonymize-chat";

export const CHAT_TOOL_SCOPE = {
  suggestTemplateFields: "suggest-template-fields",
} as const;

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

/** Portable projection of the Elysia chat-stream request schema. */
export type ChatSendRequest = {
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
  message: {
    id: SafeId<"chatMessage">;
    metadata?: unknown;
    parts: unknown[];
    role: "assistant" | "system" | "user";
  };
  sendMode: ChatSendMode;
  threadId: SafeId<"chatThread">;
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
