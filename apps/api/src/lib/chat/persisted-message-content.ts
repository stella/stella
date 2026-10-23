import type { ToolResultOutcome } from "@tanstack/ai";
import type { ToolCallState, ToolResultState } from "@tanstack/ai-client";
import { panic } from "better-result";

import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

/** JSON values are the only values that can survive the chat JSONB boundary. */
export type PersistedJsonValue =
  boolean | null | number | PersistedJsonObject | PersistedJsonValue[] | string;

export type PersistedJsonObject = {
  readonly [key: string]: PersistedJsonValue;
};

/**
 * Provider artefacts a writer stored beside a tool call (for example
 * reasoning details or a thought signature), kept exactly as stored. Whether
 * any of them is replayed on a continued turn is the runtime's decision.
 */
export type PersistedToolProviderMetadata = {
  call?: PersistedJsonObject | undefined;
  result?: PersistedJsonObject | undefined;
};

type PersistedToolCallMetadata = PersistedJsonObject & {
  [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" | "server";
};

const isPersistedToolCallMetadata = (
  value: unknown,
): value is PersistedToolCallMetadata =>
  isPersistedJsonValue(value) &&
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value[CHAT_TOOL_EXECUTOR_METADATA_KEY] === "server" ||
    value[CHAT_TOOL_EXECUTOR_METADATA_KEY] === "client");

export const provePersistedToolCallMetadata = (
  value: unknown,
): PersistedToolCallMetadata => {
  if (!isPersistedToolCallMetadata(value)) {
    panic("Tool call metadata must record executor ownership");
  }
  return value;
};

declare const parsedToolInputProof: unique symbol;
export type ParsedToolInput = {
  readonly [parsedToolInputProof]: true;
  /** The call's argument text, kept only when it does not parse to `value`. */
  rawArguments?: string;
  status: "parsed";
  value: PersistedJsonValue;
};

declare const parsedToolOutputProof: unique symbol;
export type ParsedToolOutput = {
  readonly [parsedToolOutputProof]: true;
  value: PersistedJsonValue;
};

export type PersistedToolInput =
  ParsedToolInput | { rawArguments: string; status: "raw" };

export type PersistedToolCallPart = {
  approval?: {
    approved?: boolean | undefined;
    id: string;
    needsApproval: boolean;
  };
  id: string;
  input: PersistedToolInput;
  metadata: PersistedToolCallMetadata;
  name: string;
  output?: ParsedToolOutput | undefined;
  providerMetadata?: PersistedToolProviderMetadata | undefined;
  state: ToolCallState;
  type: "tool-call";
};

export type PersistedToolResultContent =
  | { type: "paired-output-parts" }
  | { type: "parts"; value: PersistedJsonValue[] }
  | { type: "text"; value: string };

export type PersistedToolResultPart = {
  outcome?: ToolResultOutcome | undefined;
  content?: PersistedToolResultContent | undefined;
  error?: string | undefined;
  state: ToolResultState;
  toolCallId: string;
  type: "tool-result";
};

export declare const persistedChatMessageContentV3Proof: unique symbol;
type PersistedChatMessageContentV3Proof = {
  readonly [persistedChatMessageContentV3Proof]: true;
};

export type PersistedChatMessageContentV3Candidate<TPart, TMetadata> = {
  data: TPart[];
  metadata?: TMetadata | undefined;
  version: 3;
};

export type PersistedChatMessageContentV3<TPart, TMetadata> =
  PersistedChatMessageContentV3Candidate<TPart, TMetadata> &
    PersistedChatMessageContentV3Proof;

const isPersistedJsonValueAt = (
  value: unknown,
  ancestors: WeakSet<object>,
): value is PersistedJsonValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return false;
    }
    ancestors.add(value);
    const valid = value.every((item) =>
      isPersistedJsonValueAt(item, ancestors),
    );
    ancestors.delete(value);
    return valid;
  }
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Object.values(value).every((item) =>
    isPersistedJsonValueAt(item, ancestors),
  );
  ancestors.delete(value);
  return valid;
};

export const isPersistedJsonValue = (
  value: unknown,
): value is PersistedJsonValue => isPersistedJsonValueAt(value, new WeakSet());

export const isPersistedJsonObject = (
  value: unknown,
): value is PersistedJsonObject =>
  isPersistedJsonValue(value) &&
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value);

export const isPersistedToolProviderMetadata = (
  value: unknown,
): value is PersistedToolProviderMetadata =>
  isPersistedJsonObject(value) &&
  Object.keys(value).every((key) => key === "call" || key === "result") &&
  (value["call"] === undefined || isPersistedJsonObject(value["call"])) &&
  (value["result"] === undefined || isPersistedJsonObject(value["result"]));

const isParsedToolInput = (input: {
  rawArguments?: string;
  status: "parsed";
  value: unknown;
}): input is ParsedToolInput => isPersistedJsonValue(input.value);

export const proveParsedToolInput = (
  value: unknown,
  rawArguments?: string,
): ParsedToolInput => {
  const input =
    rawArguments === undefined
      ? { status: "parsed" as const, value }
      : { rawArguments, status: "parsed" as const, value };
  if (!isParsedToolInput(input)) {
    panic("Cannot mark an invalid tool input as parsed");
  }
  return input;
};

const isParsedToolOutput = (output: {
  value: unknown;
}): output is ParsedToolOutput => isPersistedJsonValue(output.value);

export const proveParsedToolOutput = (value: unknown): ParsedToolOutput => {
  const output = { value };
  if (!isParsedToolOutput(output)) {
    panic("Cannot mark an invalid tool output as parsed");
  }
  return output;
};

export const provePersistedJsonArray = (
  value: unknown,
): PersistedJsonValue[] => {
  if (!Array.isArray(value) || !value.every(isPersistedJsonValue)) {
    panic("Cannot persist a non-JSON chat array");
  }
  return value;
};

export const provePersistedChatMessageContentV3 = <TPart, TMetadata>(
  content: PersistedChatMessageContentV3Candidate<TPart, TMetadata>,
  isPersistablePart: (part: TPart) => boolean,
): PersistedChatMessageContentV3<TPart, TMetadata> => {
  if (!hasOnlyV3ProvenParts(content, isPersistablePart)) {
    panic("Cannot persist chat message content with unsupported parts");
  }
  return content;
};

const hasOnlyV3ProvenParts = <TPart, TMetadata>(
  content: PersistedChatMessageContentV3Candidate<TPart, TMetadata>,
  isPersistablePart: (part: TPart) => boolean,
): content is PersistedChatMessageContentV3<TPart, TMetadata> =>
  content.data.every(isPersistablePart);

type PersistedTextChatPart = { content: string; type: "text" };

const isPersistedTextChatPart = (
  part: unknown,
): part is PersistedTextChatPart =>
  typeof part === "object" &&
  part !== null &&
  "type" in part &&
  part.type === "text" &&
  "content" in part &&
  typeof part.content === "string";

export const proveTextOnlyPersistedChatMessageContent = <TMetadata = undefined>(
  content: PersistedChatMessageContentV3Candidate<
    PersistedTextChatPart,
    TMetadata
  >,
): PersistedChatMessageContentV3<PersistedTextChatPart, TMetadata> =>
  provePersistedChatMessageContentV3(content, isPersistedTextChatPart);
