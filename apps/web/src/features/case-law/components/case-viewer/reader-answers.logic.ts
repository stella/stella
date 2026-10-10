import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";
import { READER_ANSWER_ERROR_CODES } from "@stll/api-contract/reader-answers";
import type {
  ReaderAnswerErrorCode,
  ReaderAnswer,
  ReaderAnswerStreamEvent,
} from "@stll/api-contract/reader-answers";
import { safeIdSchema } from "@stll/api-contract/safe-id";

import { APIError } from "@/lib/errors/api";
import { readSSEEvents } from "@/lib/sse-events";
import type { SSEEvent } from "@/lib/sse-events";

export class ReaderAnswerFailure extends TaggedError("ReaderAnswerFailure")<{
  message: string;
  kind: "protocol" | "model" | "request";
  code?: ReaderAnswerErrorCode;
}> {}

// oxlint-disable-next-line require-contract-domains/require-contract-domains -- Nonnegative token and citation quantities validate the wire contract; zero is a mathematical boundary, not a product limit.
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const citation = v.object({
  decisionId: safeIdSchema,
  paragraphId: safeIdSchema,
});
const usage = v.nullable(
  v.object({
    promptTokens: count,
    completionTokens: count,
    totalTokens: count,
  }),
);
const terminal = {
  messageId: safeIdSchema,
  content: v.string(),
  citations: v.array(citation),
  invalidCitationCount: count,
};
const eventSchemas = {
  started: v.object({
    type: v.literal("started"),
    answerId: safeIdSchema,
    messageId: safeIdSchema,
  }),
  delta: v.object({
    type: v.literal("delta"),
    messageId: safeIdSchema,
    delta: v.string(),
  }),
  complete: v.object({
    type: v.literal("complete"),
    ...terminal,
    model: v.string(),
    usage,
  }),
  failed: v.object({
    type: v.literal("failed"),
    errorCode: v.picklist(READER_ANSWER_ERROR_CODES),
    ...terminal,
    message: v.string(),
  }),
} satisfies {
  [Type in ReaderAnswerStreamEvent["type"]]: v.GenericSchema<
    unknown,
    Extract<ReaderAnswerStreamEvent, { type: Type }>
  >;
};
const eventSchema = v.variant("type", Object.values(eventSchemas));

export const parseReaderAnswerEvent = (
  frame: SSEEvent,
): ReaderAnswerStreamEvent => {
  const decoded = Result.try((): unknown => JSON.parse(frame.data));
  if (decoded.isErr()) {
    throw new ReaderAnswerFailure({
      kind: "protocol",
      message: "Invalid reader answer stream",
    });
  }
  const parsed = v.safeParse(eventSchema, decoded.value);
  if (
    !parsed.success ||
    (frame.event !== "message" && parsed.output.type !== frame.event)
  ) {
    throw new ReaderAnswerFailure({
      kind: "protocol",
      message: "Invalid reader answer stream",
    });
  }
  return parsed.output;
};

type ConsumeReaderAnswerStreamOptions = {
  body: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  onEvent: (event: ReaderAnswerStreamEvent) => void;
};
export const consumeReaderAnswerStream = async ({
  body,
  signal,
  onEvent,
}: ConsumeReaderAnswerStreamOptions) => {
  let messageId: string | null = null;
  const completion = { seen: false };
  await readSSEEvents(body, (frame) => {
    if (signal.aborted) {
      return false;
    }
    const event = parseReaderAnswerEvent(frame);
    if (event.type === "started") {
      if (messageId !== null) {
        throw new ReaderAnswerFailure({
          kind: "protocol",
          message: "Reader answer stream restarted",
        });
      }
      messageId = event.messageId;
    } else if (messageId === null || event.messageId !== messageId) {
      throw new ReaderAnswerFailure({
        kind: "protocol",
        message: "Reader answer stream message mismatch",
      });
    }
    onEvent(event);
    completion.seen = event.type === "complete" || event.type === "failed";
    return !completion.seen;
  });
  if (!signal.aborted && !completion.seen) {
    throw new ReaderAnswerFailure({
      kind: "protocol",
      message: "Reader answer stream ended before completion",
    });
  }
};

type ApplyReaderAnswerEventOptions = {
  answer: ReaderAnswer;
  event: ReaderAnswerStreamEvent;
  regenerate: boolean;
  now: string;
};
export const applyReaderAnswerEvent = ({
  answer,
  event,
  regenerate,
  now,
}: ApplyReaderAnswerEventOptions): ReaderAnswer => {
  switch (event.type) {
    case "started": {
      const messages = answer.messages.slice();
      if (regenerate) {
        const index = messages.findLastIndex(
          (message) => message.role === "assistant",
        );
        if (index !== -1) {
          messages.splice(index, 1);
        }
      }
      messages.push({
        id: event.messageId,
        role: "assistant",
        status: "streaming",
        content: "",
        citations: [],
        model: null,
        usage: null,
        errorCode: null,
        invalidCitationCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      return { ...answer, messages, updatedAt: now };
    }
    case "delta":
    case "complete":
    case "failed":
      return {
        ...answer,
        updatedAt: now,
        messages: answer.messages.map((message) => {
          if (message.id !== event.messageId) {
            return message;
          }
          switch (event.type) {
            case "delta":
              return {
                ...message,
                content: message.content + event.delta,
                updatedAt: now,
              };
            case "complete":
              return {
                ...message,
                content: event.content,
                citations: event.citations,
                model: event.model,
                usage: event.usage,
                status: "complete",
                errorCode: null,
                invalidCitationCount: event.invalidCitationCount,
                updatedAt: now,
              };
            case "failed":
              return {
                ...message,
                content: event.content,
                citations: event.citations,
                status: "failed",
                errorCode: event.errorCode,
                invalidCitationCount: event.invalidCitationCount,
                updatedAt: now,
              };
            default:
              return panic(event satisfies never);
          }
        }),
      };
    default:
      return panic(event satisfies never);
  }
};

const READER_ANSWER_ERROR_KINDS = {
  "boundary-refusal": "model",
  "connector-discovery": "network",
  "empty-response": "model",
  internal: "model",
  persistence: "network",
  "provider-error": "model",
  "unsupported-input": "model",
  "client-disconnected": "network",
  "owner-lost": "network",
  timeout: "timeout",
  [ACTION_ADMISSION_CODES.periodExhausted]: "budget",
  [ACTION_ADMISSION_CODES.concurrencyBusy]: "network",
  [ACTION_ADMISSION_CODES.notEnabled]: "network",
  [ACTION_ADMISSION_CODES.admissionUnavailable]: "network",
} as const satisfies Record<ReaderAnswerErrorCode, string>;

export type ReaderAnswerFailureKind =
  (typeof READER_ANSWER_ERROR_KINDS)[ReaderAnswerErrorCode];

export const readerAnswerErrorCodeKind = (
  code: ReaderAnswerErrorCode | null,
) => (code === null ? undefined : READER_ANSWER_ERROR_KINDS[code]);

export const readerAnswerFailureKind = (
  error: unknown,
): ReaderAnswerFailureKind | undefined => {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (
    APIError.is(error) &&
    error.code === ACTION_ADMISSION_CODES.periodExhausted
  ) {
    return "budget";
  }
  if (!ReaderAnswerFailure.is(error)) {
    return "network";
  }
  if (error.code !== undefined) {
    return readerAnswerErrorCodeKind(error.code);
  }
  return error.kind === "model" ? "model" : "network";
};
