import type { ChatMessage } from "@/api/handlers/chat/types";

type ChatPart = ChatMessage["parts"][number];
type CreateDocumentInput = {
  name: string;
  source: string;
};

const CREATE_DOCUMENT_TOOL_PART_TYPE = "tool-create-document";

export const normalizeLegacyRawToolInputs = (
  parts: readonly unknown[],
): unknown[] =>
  parts.map((part) => normalizeLegacyRawCreateDocumentInput(part));

export const normalizeLegacyToolInputs = (
  parts: ChatMessage["parts"],
): ChatMessage["parts"] =>
  parts.map((part) => normalizeLegacyCreateDocumentPart(part));

const normalizeLegacyCreateDocumentPart = (part: ChatPart): ChatPart => {
  if (
    part.type !== CREATE_DOCUMENT_TOOL_PART_TYPE ||
    !("input" in part) ||
    part.input === undefined
  ) {
    return part;
  }

  const input = normalizeCreateDocumentInput(part.input);
  if (!input) {
    return part;
  }

  return { ...part, input };
};

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

const normalizeLegacyRawCreateDocumentInput = (part: unknown): unknown => {
  if (!isRecord(part) || part["type"] !== CREATE_DOCUMENT_TOOL_PART_TYPE) {
    return part;
  }

  const rawInput = part["input"];
  if (!isRecord(rawInput)) {
    return part;
  }

  const hasLegacyMarkdown = "markdown" in rawInput;
  const source =
    getStringProperty(rawInput, "source") ??
    getStringProperty(rawInput, "markdown");
  if (!hasLegacyMarkdown || !source) {
    return part;
  }

  const input = { ...rawInput };
  delete input["markdown"];
  input["source"] = source;

  return { ...part, input };
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
