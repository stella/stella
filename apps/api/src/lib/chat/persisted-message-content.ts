import type { ToolCallState, ToolResultState } from "@tanstack/ai-client";
import { panic } from "better-result";

/** JSON values are the only values that can survive the chat JSONB boundary. */
export type PersistedJsonValue =
  | boolean
  | null
  | number
  | PersistedJsonObject
  | PersistedJsonValue[]
  | string;

export type PersistedJsonObject = {
  readonly [key: string]: PersistedJsonValue;
};

export declare const parsedToolInputProof: unique symbol;
export type ParsedToolInput = {
  readonly [parsedToolInputProof]: true;
  status: "parsed";
  value: PersistedJsonValue;
};

export declare const parsedToolOutputProof: unique symbol;
export type ParsedToolOutput = {
  readonly [parsedToolOutputProof]: true;
  value: PersistedJsonValue;
};

export type PersistedToolInput =
  | ParsedToolInput
  | { rawArguments: string; status: "raw" };

export type PersistedToolCallPart = {
  approval?: {
    approved?: boolean | undefined;
    id: string;
    needsApproval: boolean;
  };
  id: string;
  input: PersistedToolInput;
  metadata?: PersistedJsonValue | undefined;
  name: string;
  output?: ParsedToolOutput | undefined;
  state: ToolCallState;
  type: "tool-call";
};

export type PersistedToolResultContent =
  | { type: "paired-output-parts" }
  | { type: "parts"; value: PersistedJsonValue[] }
  | { type: "text"; value: string };

export type PersistedToolResultPart = {
  content?: PersistedToolResultContent | undefined;
  error?: string | undefined;
  state: ToolResultState;
  toolCallId: string;
  type: "tool-result";
};

export type PersistedChatPart<TOtherPart> =
  | PersistedToolCallPart
  | PersistedToolResultPart
  | TOtherPart;

type PersistedChatMessageContentCandidate<TPart, TMetadata> = {
  data: TPart[];
  metadata?: TMetadata | undefined;
  version: 2;
};

export declare const persistedChatMessageContentProof: unique symbol;
type PersistedChatMessageContentProof = {
  readonly [persistedChatMessageContentProof]: true;
};
type ProvenPersistedChatMessageContent<TContent> = TContent &
  PersistedChatMessageContentProof;

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

export const isPersistedJsonValue = (
  value: unknown,
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
    return value.every(isPersistedJsonValue);
  }
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return false;
  }
  return Object.values(value).every(isPersistedJsonValue);
};

export const provePersistedJsonValue = (value: unknown): PersistedJsonValue => {
  if (!isPersistedJsonValue(value)) {
    panic("Cannot persist a non-JSON chat value");
  }
  return value;
};

const isParsedToolInput = (input: {
  status: "parsed";
  value: unknown;
}): input is ParsedToolInput => isPersistedJsonValue(input.value);

export const proveParsedToolInput = (value: unknown): ParsedToolInput => {
  const input = { status: "parsed" as const, value };
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

const hasOnlyProvenParts = <TPart, TMetadata>(
  content: PersistedChatMessageContentCandidate<TPart, TMetadata>,
  isPersistablePart: (part: TPart) => boolean,
): content is ProvenPersistedChatMessageContent<
  PersistedChatMessageContentCandidate<TPart, TMetadata>
> => content.data.every(isPersistablePart);

const provePersistedChatMessageContent = <TPart, TMetadata>(
  content: PersistedChatMessageContentCandidate<TPart, TMetadata>,
  isPersistablePart: (part: TPart) => boolean,
): ProvenPersistedChatMessageContent<
  PersistedChatMessageContentCandidate<TPart, TMetadata>
> => {
  if (!hasOnlyProvenParts(content, isPersistablePart)) {
    panic("Cannot persist chat message content with unsupported parts");
  }
  return content;
};

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

export const proveTextOnlyPersistedChatMessageContent = <TMetadata>(
  content: PersistedChatMessageContentCandidate<
    PersistedTextChatPart,
    TMetadata
  >,
): ProvenPersistedChatMessageContent<
  PersistedChatMessageContentCandidate<PersistedTextChatPart, TMetadata>
> => provePersistedChatMessageContent(content, isPersistedTextChatPart);
