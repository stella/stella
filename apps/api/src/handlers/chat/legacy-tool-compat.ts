import { BROWSER_CONTROL_TOOL_NAME } from "@stll/api-contract/browser-control";
import {
  ASK_USER_TOOL_NAME,
  CREATE_DOCUMENT_TOOL_NAME,
} from "@stll/api-contract/chat";
import { REQUEST_SECRET_TOOL_NAME } from "@stll/api-contract/chat-secret";
import { FOLIO_AGENT_TOOL_NAMES } from "@stll/folio-agents";

import type {
  createFolioAgentDocTools,
  createSuggestChangesTools,
} from "@/api/handlers/chat/tools/folio-agent-tools";

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

export const legacyChatToolExecutor = (name: string): "client" | "server" =>
  LEGACY_CLIENT_TOOL_NAMES.has(name) ? "client" : "server";

type CreateDocumentInput = {
  name: string;
  source: string;
};
type CreateDocumentOutput =
  | {
      success: true;
      fileName: string;
      entityId: string;
      fieldId: string;
      workspaceId: string;
      entityRef: string;
      matterRef: string;
      href: string;
      mention: string;
    }
  | {
      success: false;
      message: string;
    };

const CREATE_DOCUMENT_TOOL_PART_TYPE = "tool-create-document";
// Old outputs predate route IDs. Empty IDs pass historical-message validation
// while keeping the web "open created document" affordance hidden.
const LEGACY_MISSING_ROUTE_ID = "";

export const normalizeLegacyRawToolInputs = (
  parts: readonly unknown[],
): unknown[] => parts.map((part) => normalizeLegacyRawCreateDocumentPart(part));

const normalizeCreateDocumentInput = (
  input: unknown,
): CreateDocumentInput | null => {
  const name = getStringProperty(input, "name");
  const source =
    getStringProperty(input, "source") ?? getStringProperty(input, "markdown");
  if (!name || !source) {
    return null;
  }

  return { name, source };
};

const normalizeCreateDocumentOutput = (
  output: unknown,
): CreateDocumentOutput | null => {
  if (!isRecord(output)) {
    return null;
  }

  if (output["success"] === false) {
    const message = getStringProperty(output, "message");
    return message ? { success: false, message } : null;
  }

  if (output["success"] !== true) {
    return null;
  }

  const fileName = getStringProperty(output, "fileName");
  const entityRef = getStringProperty(output, "entityRef");
  const matterRef = getStringProperty(output, "matterRef");
  const href = getStringProperty(output, "href");
  const mention = getStringProperty(output, "mention");
  if (!fileName || !entityRef || !matterRef || !href || !mention) {
    return null;
  }

  return {
    success: true,
    fileName,
    entityId: getStringProperty(output, "entityId") ?? LEGACY_MISSING_ROUTE_ID,
    fieldId: getStringProperty(output, "fieldId") ?? LEGACY_MISSING_ROUTE_ID,
    workspaceId:
      getStringProperty(output, "workspaceId") ?? LEGACY_MISSING_ROUTE_ID,
    entityRef,
    matterRef,
    href,
    mention,
  };
};

const normalizeLegacyRawCreateDocumentPart = (part: unknown): unknown => {
  if (!isRecord(part) || part["type"] !== CREATE_DOCUMENT_TOOL_PART_TYPE) {
    return part;
  }

  const input = normalizeCreateDocumentInput(part["input"]);
  const output = normalizeCreateDocumentOutput(part["output"]);
  if (!input && !output) {
    return part;
  }

  return {
    ...part,
    ...(input && { input }),
    ...(output && { output }),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getStringProperty = (value: unknown, key: string): string | null => {
  if (!isRecord(value)) {
    return null;
  }

  const property = value[key];
  return typeof property === "string" ? property : null;
};
