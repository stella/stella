import { APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME } from "@/api/handlers/chat/tools/active-docx-edit-tool";

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonObject = (text: string): JsonObject | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeOperation = (value: unknown): JsonObject | null => {
  const operation = typeof value === "string" ? parseJsonObject(value) : value;

  if (!isJsonObject(operation)) {
    return null;
  }

  const type = (() => {
    if (typeof operation["type"] === "string") {
      return operation["type"];
    }
    if (typeof operation["kind"] === "string") {
      return operation["kind"];
    }
    if (
      typeof operation["find"] === "string" &&
      typeof operation["replace"] === "string"
    ) {
      return "replaceInBlock";
    }
    return null;
  })();
  const blockId = (() => {
    if (typeof operation["blockId"] === "string") {
      return operation["blockId"];
    }
    if (typeof operation["id"] === "string") {
      return operation["id"];
    }
    return null;
  })();

  if (type === null || blockId === null) {
    return null;
  }

  const normalized: JsonObject = {
    ...operation,
    blockId,
    type,
  };
  delete normalized["id"];
  delete normalized["kind"];

  return normalized;
};

export const normalizeActiveDocxEditToolInput = (
  input: string,
): string | null => {
  const parsed = parseJsonObject(input);
  if (!parsed || !Array.isArray(parsed["operations"])) {
    return null;
  }

  const operations: JsonObject[] = [];
  for (const operation of parsed["operations"]) {
    const normalized = normalizeOperation(operation);
    if (normalized === null) {
      return null;
    }
    operations.push(normalized);
  }

  return JSON.stringify({ operations });
};

export const repairActiveDocxEditToolCall = <
  TToolCall extends {
    input: string;
    toolName: string;
  },
>(
  toolCall: TToolCall,
): TToolCall | null => {
  if (toolCall.toolName !== APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME) {
    return null;
  }

  const input = normalizeActiveDocxEditToolInput(toolCall.input);
  return input === null ? null : { ...toolCall, input };
};
