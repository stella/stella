import { panic } from "better-result";

import { BROWSER_CONTROL_TOOL_NAME } from "@stll/api-contract/browser-control";
import {
  ASK_USER_TOOL_NAME,
  CHAT_TOOL_EXECUTOR_METADATA_KEY,
  chatToolExecutor,
  CREATE_DOCUMENT_TOOL_NAME,
} from "@stll/api-contract/chat";
import { REQUEST_SECRET_TOOL_NAME } from "@stll/api-contract/chat-secret";
import { FOLIO_AGENT_TOOL_NAMES } from "@stll/folio-agents";

import type {
  createFolioAgentDocTools,
  createSuggestChangesTools,
} from "@/api/handlers/chat/tools/folio-agent-tools";
import type { ChatPart } from "@/api/handlers/chat/types";
import { isRecord } from "@/api/lib/type-guards";

type FolioClientToolName =
  | keyof ReturnType<typeof createFolioAgentDocTools>
  | keyof ReturnType<typeof createSuggestChangesTools>;
const FOLIO_CLIENT_TOOL_NAMES = {
  [FOLIO_AGENT_TOOL_NAMES.findText]: true,
  [FOLIO_AGENT_TOOL_NAMES.getDocumentOutline]: true,
  [FOLIO_AGENT_TOOL_NAMES.listStories]: true,
  [FOLIO_AGENT_TOOL_NAMES.readChanges]: true,
  [FOLIO_AGENT_TOOL_NAMES.readComments]: true,
  [FOLIO_AGENT_TOOL_NAMES.readDocument]: true,
  [FOLIO_AGENT_TOOL_NAMES.readSection]: true,
  [FOLIO_AGENT_TOOL_NAMES.readStory]: true,
  [FOLIO_AGENT_TOOL_NAMES.showInDocument]: true,
  [FOLIO_AGENT_TOOL_NAMES.suggestChanges]: true,
  [FOLIO_AGENT_TOOL_NAMES.addComment]: true,
  [FOLIO_AGENT_TOOL_NAMES.replyComment]: true,
  [FOLIO_AGENT_TOOL_NAMES.resolveComment]: true,
} as const satisfies Record<FolioClientToolName, true>;
const LEGACY_CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(FOLIO_CLIENT_TOOL_NAMES),
  ASK_USER_TOOL_NAME,
  CREATE_DOCUMENT_TOOL_NAME,
  REQUEST_SECRET_TOOL_NAME,
  BROWSER_CONTROL_TOOL_NAME,
]);

const legacyChatToolExecutor = (name: string): "client" | "server" =>
  LEGACY_CLIENT_TOOL_NAMES.has(name) ? "client" : "server";

export const normalizeStoredChatToolExecutor = (part: ChatPart): ChatPart => {
  if (part.type !== "tool-call" || chatToolExecutor(part) !== null) {
    return part;
  }
  const metadata = part.metadata;
  // Every writer proves its content before storing it, so a stored call with
  // non-object metadata or an unrecognised executor is corrupted state.
  if (metadata !== undefined && !isRecord(metadata)) {
    return panic("Stored tool call has invalid metadata");
  }
  const provider = isRecord(metadata) ? metadata : {};
  if (provider[CHAT_TOOL_EXECUTOR_METADATA_KEY] !== undefined) {
    return panic("Stored tool call has invalid executor ownership");
  }
  // Stored calls predate recorded ownership and deferred server execution.
  // A request registry must never change ownership of a historical call.
  return {
    ...part,
    metadata: {
      ...provider,
      [CHAT_TOOL_EXECUTOR_METADATA_KEY]: legacyChatToolExecutor(part.name),
    },
  };
};
