import { panic } from "better-result";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { TanStackAIProvider } from "@stll/ai-catalog";
import type { AIErrorKind } from "@stll/api-contract";

import type {
  ChatTurnFailureCode,
  ChatTurnInteractionType,
  ChatTurnStatus,
} from "@/api/handlers/chat/chat-turn-state";
import type { TanStackTextFinishReason } from "@/api/lib/chat/tanstack-chat-runtime";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { PLAIN_TOOL_NAME } from "@/api/tests/helpers/chat-approval-harness";
import {
  emptyCompletionAnswer,
  mapDataEvents,
  mapGeminiParts,
  REASONING_ANSWERS,
  REASONING_TEXT,
} from "@/api/tests/helpers/provider-reasoning-answers";
import {
  modelOf,
  product,
  reasoningModelOf,
} from "@/api/tests/helpers/provider-request-matrix";
import {
  cassetteFor,
  NOT_APPLICABLE,
  WIRE_TOOL_NAME,
} from "@/api/tests/helpers/provider-wire-cassette";
import type {
  AwsEventStreamMessage,
  ProviderWireCassette,
  ProviderWireExchange,
  ProviderWireScenario,
} from "@/api/tests/helpers/provider-wire-cassette";

// The ways a model can answer a chat turn, the places in a conversation a
// turn can start from, and every provider's adapter, as typed dimensions,
// with every combination the product can produce. Each answer is a provider
// response on the wire (`provider-wire-cassette.ts`), so it goes through the
// provider's real adapter; each combination settles a turn that
// `chat-turn-outcome.ts` holds to what the turn showed. A combination is
// excluded only where a named predicate says the product or the provider's
// protocol cannot produce it. `provider-request-matrix.ts` builds the
// covers the runs take.

// --- Response shapes ----------------------------------------------------------

/** Every shape of answer a provider can stream for one model call. */
const RESPONSE_SHAPES = {
  text: "A plain text answer (the control).",
  empty: "A normal stop with an empty text message.",
  whitespace: "A normal stop whose text is only whitespace.",
  "reasoning-only": "Reasoning, then a normal stop with no text.",
  "tool-call": "A call of a tool behind an approval.",
  "tool-call-then-empty":
    "A call of a tool the loop runs at once, then an empty text message.",
  "structured-output-empty": "A structured output with nothing in it.",
  length: "Text cut off at the output limit.",
  refusal: "The provider declines to answer.",
  "content-filter": "The provider's content filter stops the answer.",
  "mid-stream-error": "An unreadable event partway through the stream.",
  "early-eof": "The stream stops before its terminal event.",
  "duplicate-terminal": "A text answer whose terminal event arrives twice.",
  "text-terminal-only": "Text that arrives only in the terminal event.",
  "unusable-stop": "A stop reason no answer stands on.",
  "unlisted-stop": "A stop reason the SDK does not list yet.",
  "fails-before-output": "The provider refuses the request before any output.",
} as const satisfies Record<string, string>;

export type ResponseShape = keyof typeof RESPONSE_SHAPES;
export const RESPONSE_SHAPE_NAMES = Object.keys(RESPONSE_SHAPES).filter(
  (shape): shape is ResponseShape => shape in RESPONSE_SHAPES,
);

/**
 * What the run a shape answers shows the user: an answer in text, a card
 * it waits on, a call the loop ran, nothing (after a normal stop or another
 * one), or a provider failure.
 */
export type ShapeVerdict =
  | { kind: "answer" }
  | { kind: "card" }
  | { kind: "ran-call" }
  | { finishReason: string; kind: "nothing" }
  | { kind: "failure" };

/** A shape as one provider streams it. */
export type ShapeAnswer = {
  exchanges: ProviderWireExchange[];
  /** Whether the stream carries reasoning the run must store. */
  reasoning: boolean;
  verdict: ShapeVerdict;
};

// --- Coverage of the source unions ----------------------------------------------
//
// A new member of any union that decides how a provider answer ends fails
// typecheck here until it names the shape that covers it.

type NotAShape = { notAShape: string };

/** Every scenario of the provider wire corpus. */
export const WIRE_SCENARIO_SHAPES = {
  text: ["text", "empty", "whitespace", "reasoning-only", "duplicate-terminal"],
  "text-terminal-only": ["text-terminal-only"],
  "tool-call": ["tool-call", "tool-call-then-empty"],
  "parallel-tool-calls": {
    notAShape:
      "Two calls settle like one: the turn waits on the approval cards (`tool-call`).",
  },
  "strict-null": {
    notAShape:
      "A call whose optional field is null: a tool input shape, settled like `tool-call`.",
  },
  length: ["length"],
  refusal: ["refusal", "content-filter"],
  "bad-request": ["fails-before-output"],
  "rate-limit": {
    notAShape:
      "Retried with backoff, then refused before any output, as `fails-before-output`.",
  },
  "server-error": {
    notAShape:
      "Retried with backoff, then refused before any output, as `fails-before-output`.",
  },
  "malformed-chunk": ["mid-stream-error"],
  "early-eof": ["early-eof"],
  "unusable-stop": ["unusable-stop"],
  "unlisted-stop": ["unlisted-stop"],
} as const satisfies Record<
  ProviderWireScenario,
  NotAShape | readonly ResponseShape[]
>;

/** Every way a run can report it finished. */
export const FINISH_REASON_SHAPES = {
  stop: ["text", "empty", "whitespace", "reasoning-only"],
  length: ["length"],
  content_filter: ["refusal", "content-filter"],
  tool_calls: ["tool-call", "tool-call-then-empty"],
} as const satisfies Record<
  NonNullable<TanStackTextFinishReason>,
  readonly ResponseShape[]
>;

const REFUSED_BEFORE_OUTPUT: NotAShape = {
  notAShape:
    "A request the provider refuses before any output (`fails-before-output`); the kind is the refusal's classification.",
};

/** Every error a failed run is classified as. */
export const AI_ERROR_KIND_SHAPES = {
  quota_exhausted: REFUSED_BEFORE_OUTPUT,
  provider_billing: REFUSED_BEFORE_OUTPUT,
  provider_credentials_rejected: REFUSED_BEFORE_OUTPUT,
  model_unavailable: ["fails-before-output"],
  provider_unavailable: REFUSED_BEFORE_OUTPUT,
  provider_stream_incomplete: ["early-eof", "unusable-stop"],
  output_incomplete: {
    notAShape:
      "A structured answer cut off or unparseable (`generateTanStackObjectForRole`); a chat turn keeps a `length` answer.",
  },
  output_invalid: {
    notAShape:
      "A structured answer its schema rejects (`generateTanStackObjectForRole`); a chat turn carries no schema.",
  },
  deadline_exceeded: {
    notAShape:
      "A caller's own deadline on an awaited generation (`deadlineMs`); a chat turn is bounded by its lease instead.",
  },
  loop_detected: {
    notAShape:
      "Read across several runs of a turn, not from one answer (`detectModelLoop`).",
  },
  empty_completion: ["empty", "whitespace", "reasoning-only"],
  unknown: ["mid-stream-error"],
} as const satisfies Record<AIErrorKind, NotAShape | readonly ResponseShape[]>;

// --- Turn positions ------------------------------------------------------------

/** Where in a conversation the turn whose run the shape answers starts. */
export const TURN_POSITIONS = {
  fresh: "The first message of a thread.",
  "after-ask-user": "The continuation once the user answers a question card.",
  "after-approval": "The continuation once the user approves a call.",
  "after-denial": "The continuation once the user denies a call.",
  "after-client-tool":
    "The continuation once the page posts a client tool's result.",
  "after-tool-result":
    "The model call after a tool the loop ran, in the same run.",
  "after-compaction": "A message on a thread the compactor summarized.",
  "resume-after-restart":
    "A retry on a turn the reaper ended after its process died.",
  "skill-run": "A message sent with a skill active.",
  fallback:
    "The fallback model's answer once the chat model answered with nothing.",
  "subagent-child":
    "A subagent's own run, whose answer its parent shows (surface `subagent`).",
} as const satisfies Record<string, string>;

export type TurnPosition = keyof typeof TURN_POSITIONS;
const TURN_POSITION_NAMES = Object.keys(TURN_POSITIONS).filter(
  (position): position is TurnPosition => position in TURN_POSITIONS,
);

/** Every interaction a turn can wait on, by the position that answers it. */
export const INTERACTION_POSITIONS = {
  "ask-user": ["after-ask-user"],
  approval: ["after-approval", "after-denial"],
  "client-tool": ["after-client-tool"],
} as const satisfies Record<ChatTurnInteractionType, readonly TurnPosition[]>;

// --- Surfaces -----------------------------------------------------------------

/**
 * Every builder that shows model output beside the chat turn: what the user
 * sees of it, which must never be a blank.
 */
export const SURFACES = {
  "thread-title": "The thread's title.",
  "thread-recap": "The recap of a thread the user returns to.",
  "follow-up-suggestions": "The suggested prompts under the last answer.",
  subagent: "A subagent's answer, as its parent's tool result shows it.",
} as const satisfies Record<string, string>;

type Surface = keyof typeof SURFACES;
const SURFACE_NAMES = Object.keys(SURFACES).filter(
  (surface): surface is Surface => surface in SURFACES,
);

// --- Writing each shape on the wire ---------------------------------------------

type TextSlot = "delta" | "whole";

/**
 * Rewrites every place `provider`'s stream event `data` carries answer text
 * (not reasoning): `rewrite` gets the slot's text and whether it is a delta
 * of the answer or the whole answer repeated.
 */
const rewriteTextSlots = (
  provider: TanStackAIProvider,
  data: Record<string, unknown>,
  rewrite: (text: string, slot: TextSlot) => string,
): Record<string, unknown> => {
  const withText = (
    part: Record<string, unknown>,
    slot: TextSlot,
    key = "text",
  ): Record<string, unknown> => {
    const text = part[key];
    return typeof text !== "string" || part["thought"] === true
      ? part
      : { ...part, [key]: rewrite(text, slot) };
  };
  const outputText = (item: unknown): unknown => {
    if (!isRecord(item) || !isUnknownArray(item["content"])) {
      return item;
    }
    return {
      ...item,
      content: item["content"].map((part) =>
        isRecord(part) && part["type"] === "output_text"
          ? withText(part, "whole")
          : part,
      ),
    };
  };
  switch (provider) {
    case "anthropic": {
      const delta = data["delta"];
      return isRecord(delta) && delta["type"] === "text_delta"
        ? { ...data, delta: withText(delta, "delta") }
        : data;
    }
    case "openai": {
      const type = data["type"];
      if (type === "response.output_text.delta") {
        return withText(data, "delta", "delta");
      }
      if (type === "response.output_text.done") {
        return withText(data, "whole");
      }
      if (
        type === "response.content_part.added" ||
        type === "response.content_part.done"
      ) {
        const part = data["part"];
        return isRecord(part) && part["type"] === "output_text"
          ? { ...data, part: withText(part, "whole") }
          : data;
      }
      if (
        type === "response.output_item.added" ||
        type === "response.output_item.done"
      ) {
        return { ...data, item: outputText(data["item"]) };
      }
      const response = data["response"];
      if (isRecord(response) && isUnknownArray(response["output"])) {
        return {
          ...data,
          response: { ...response, output: response["output"].map(outputText) },
        };
      }
      return data;
    }
    case "mistral":
    case "openrouter": {
      const choices = data["choices"];
      if (!isUnknownArray(choices)) {
        return data;
      }
      const withChoiceText = (choice: unknown): unknown => {
        const delta = isRecord(choice) ? choice["delta"] : undefined;
        return isRecord(choice) && isRecord(delta)
          ? { ...choice, delta: withText(delta, "delta", "content") }
          : choice;
      };
      return { ...data, choices: choices.map(withChoiceText) };
    }
    case "google":
      return mapGeminiParts(data, (parts) =>
        parts.map((part) => withText(part, "delta")),
      );
    case "bedrock": {
      const delta = data["delta"];
      return isRecord(delta)
        ? { ...data, delta: withText(delta, "delta") }
        : data;
    }
    default:
      provider satisfies never;
      return panic(`Unhandled provider: ${String(provider)}`);
  }
};

/** Every event of each exchange's body rewritten by `rewrite`. */
const mapEvents = (
  exchanges: readonly ProviderWireExchange[],
  rewrite: (data: Record<string, unknown>) => Record<string, unknown>,
): ProviderWireExchange[] => {
  const rewriteMessage = (
    message: AwsEventStreamMessage,
  ): AwsEventStreamMessage =>
    isRecord(message.payload)
      ? { ...message, payload: rewrite(message.payload) }
      : message;
  return exchanges.map((exchange): ProviderWireExchange => {
    const { body } = exchange.response;
    if (body.encoding === "text") {
      return {
        ...exchange,
        response: {
          ...exchange.response,
          body: { ...body, text: mapDataEvents(body.text, rewrite) },
        },
      };
    }
    return {
      ...exchange,
      response: {
        ...exchange.response,
        body: {
          ...body,
          messages: body.messages.map(rewriteMessage),
        },
      },
    };
  });
};

/** `exchanges` with the whole answer text replaced by `text`. */
const withAnswerText = (
  provider: TanStackAIProvider,
  exchanges: readonly ProviderWireExchange[],
  text: string,
): ProviderWireExchange[] => {
  let written = false;
  return mapEvents(exchanges, (data) =>
    rewriteTextSlots(provider, data, (_, slot) => {
      if (slot === "whole") {
        return text;
      }
      if (written) {
        return "";
      }
      written = true;
      return text;
    }),
  );
};

/** The answer text `exchanges` stream, read from the same slots. */
const answerTextOf = (
  provider: TanStackAIProvider,
  exchanges: readonly ProviderWireExchange[],
): string => {
  let text = "";
  mapEvents(exchanges, (data) =>
    rewriteTextSlots(provider, data, (piece, slot) => {
      if (slot === "delta") {
        text += piece;
      }
      return piece;
    }),
  );
  return text;
};

/** A chat completions chunk carrying `delta`, before the first chunk with a
 *  choice. */
const withLeadingChoice = (
  exchanges: readonly ProviderWireExchange[],
  delta: Record<string, unknown>,
): ProviderWireExchange[] =>
  exchanges.map((exchange): ProviderWireExchange => {
    const { body } = exchange.response;
    if (body.encoding !== "text") {
      return panic("A chat completions answer is a text event stream");
    }
    const events = body.text.split("\n\n");
    const index = events.findIndex((event) => event.includes('"choices"'));
    const template = events[index]?.slice("data: ".length);
    const parsed: unknown =
      template === undefined ? undefined : JSON.parse(template);
    if (!isRecord(parsed)) {
      return panic("A chat completions answer streams a choice");
    }
    const chunk = {
      ...parsed,
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    return {
      ...exchange,
      response: {
        ...exchange.response,
        body: {
          ...body,
          text: [
            ...events.slice(0, index),
            `data: ${JSON.stringify(chunk)}`,
            ...events.slice(index),
          ].join("\n\n"),
        },
      },
    };
  });

/** An OpenAI Responses reasoning summary delta, streamed before the answer. */
const withOpenAiReasoningDelta = (
  exchanges: readonly ProviderWireExchange[],
): ProviderWireExchange[] =>
  exchanges.map((exchange): ProviderWireExchange => {
    const { body } = exchange.response;
    if (body.encoding !== "text") {
      return panic("An OpenAI answer is a text event stream");
    }
    const events = body.text.split("\n\n");
    const index = events.findIndex((event) =>
      event.includes("response.output_item.added"),
    );
    const delta = {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_cassette_reasoning",
      output_index: 0,
      summary_index: 0,
      delta: REASONING_TEXT,
    };
    return {
      ...exchange,
      response: {
        ...exchange.response,
        body: {
          ...body,
          text: [
            ...events.slice(0, index),
            `event: ${delta.type}\ndata: ${JSON.stringify(delta)}`,
            ...events.slice(index),
          ].join("\n\n"),
        },
      },
    };
  });

/** `exchanges` with reasoning streamed before the (emptied) answer. */
const withReasoning = (
  provider: TanStackAIProvider,
  cassette: ProviderWireCassette,
): ProviderWireExchange[] => {
  const reasoned = (
    answer: (c: ProviderWireCassette) => ProviderWireCassette,
  ) => answer(cassette).exchanges;
  switch (provider) {
    case "anthropic":
    case "bedrock":
      return reasoned(REASONING_ANSWERS[provider].reasoning);
    case "openai":
      return withOpenAiReasoningDelta(
        reasoned(REASONING_ANSWERS.openai.reasoning),
      );
    case "google":
      return mapEvents(cassette.exchanges, (data) =>
        mapGeminiParts(data, (parts) =>
          parts.some((part) => typeof part["text"] === "string")
            ? [{ text: REASONING_TEXT, thought: true }, ...parts]
            : [...parts],
        ),
      );
    case "mistral":
      return withLeadingChoice(cassette.exchanges, {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: [{ type: "text", text: REASONING_TEXT }],
          },
        ],
      });
    case "openrouter":
      return withLeadingChoice(cassette.exchanges, {
        role: "assistant",
        content: null,
        reasoning: REASONING_TEXT,
        reasoning_details: [
          {
            type: "reasoning.text",
            text: REASONING_TEXT,
            format: "unknown",
            index: 0,
          },
        ],
      });
    default:
      provider satisfies never;
      return panic(`Unhandled provider: ${String(provider)}`);
  }
};

/** Every string `from` in the exchanges' events, as `to`. */
const renamed = (
  exchanges: readonly ProviderWireExchange[],
  from: string,
  to: string,
): ProviderWireExchange[] => {
  const rename = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replaceAll(from, () => to);
    }
    if (isUnknownArray(value)) {
      return value.map(rename);
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, rename(child)]),
      );
    }
    return value;
  };
  return mapEvents(exchanges, (data) => {
    const result = rename(data);
    return isRecord(result) ? result : data;
  });
};

/** `exchanges` with the last event of the stream (before any `[DONE]`)
 *  sent twice. */
const withDuplicateTerminal = (
  exchanges: readonly ProviderWireExchange[],
): ProviderWireExchange[] =>
  exchanges.map((exchange): ProviderWireExchange => {
    const { body } = exchange.response;
    if (body.encoding !== "text") {
      const last = body.messages.at(-1);
      return {
        ...exchange,
        response: {
          ...exchange.response,
          body: {
            ...body,
            messages:
              last === undefined ? body.messages : [...body.messages, last],
          },
        },
      };
    }
    const events = body.text.split("\n\n");
    const index = events.findLastIndex(
      (event) => event.trim() !== "" && !event.includes("[DONE]"),
    );
    const terminal = events[index];
    if (terminal === undefined) {
      return panic("A stream has a terminal event");
    }
    return {
      ...exchange,
      response: {
        ...exchange.response,
        body: {
          ...body,
          text: [
            ...events.slice(0, index + 1),
            terminal,
            ...events.slice(index + 1),
          ].join("\n\n"),
        },
      },
    };
  });

/** What a recorded or synthetic scenario's answer shows, by its cassette's
 *  own expectation. */
const verdictOf = (
  provider: TanStackAIProvider,
  cassette: ProviderWireCassette,
): ShapeVerdict => {
  const { expect } = cassette;
  if (expect.outcome === "error") {
    return { kind: "failure" };
  }
  const text = expect.text ?? answerTextOf(provider, cassette.exchanges);
  return text.trim() === ""
    ? { finishReason: expect.finishReason, kind: "nothing" }
    : { kind: "answer" };
};

/**
 * `scenario`'s cassette of `provider` (its `variant`, if named), as the
 * answer to a request to the provider's chat endpoint for the model of its
 * text cassette: every shape of a provider answers the one request.
 */
const sourceOf = (
  cassettes: readonly ProviderWireCassette[],
  provider: TanStackAIProvider,
  scenario: ProviderWireScenario,
  variant?: string,
): ProviderWireCassette => {
  const cassette =
    variant === undefined
      ? cassetteFor(cassettes, provider, scenario)
      : (variantOf(cassettes, provider, scenario, variant) ??
        panic(`No ${provider}/${scenario}.${variant} cassette`));
  const text = cassetteFor(cassettes, provider, "text");
  const path =
    text.exchanges[0]?.request.path ?? panic("A text cassette has a request");
  const toChatEndpoint = (
    exchange: ProviderWireExchange,
  ): ProviderWireExchange => ({
    ...exchange,
    request: { ...exchange.request, path },
  });
  return {
    ...cassette,
    model: text.model,
    exchanges: cassette.exchanges.map(toChatEndpoint),
  };
};

const variantOf = (
  cassettes: readonly ProviderWireCassette[],
  provider: TanStackAIProvider,
  scenario: ProviderWireScenario,
  variant: string,
): ProviderWireCassette | undefined =>
  cassettes.find(
    (cassette) =>
      cassette.provider === provider &&
      cassette.scenario === scenario &&
      cassette.variant === variant,
  );

const scenarioAnswer = (
  cassettes: readonly ProviderWireCassette[],
  provider: TanStackAIProvider,
  scenario: ProviderWireScenario,
): ShapeAnswer | { notApplicable: string } => {
  const reason = NOT_APPLICABLE[provider]?.[scenario];
  if (reason !== undefined) {
    return { notApplicable: `NOT_APPLICABLE: ${reason}` };
  }
  const cassette = sourceOf(cassettes, provider, scenario);
  return {
    exchanges: cassette.exchanges,
    reasoning: false,
    verdict: verdictOf(provider, cassette),
  };
};

/**
 * The cassette of a provider's content filter stopping an answer: the filter
 * variant of its refusal scenario where the protocol reports the filter
 * apart from a refusal. Where it has one stop for both, the refusal
 * scenario is that stop.
 */
const CONTENT_FILTER_VARIANT = {
  anthropic: {
    notApplicable:
      "One stop for both: `refusal` is the classifier's stop (stop_reason refusal).",
  },
  bedrock: "guardrail",
  google: "prompt-blocked",
  mistral: {
    notApplicable: `NOT_APPLICABLE: ${NOT_APPLICABLE.mistral?.refusal ?? ""}`,
  },
  openai: "incomplete",
  openrouter: {
    notApplicable:
      "One stop for both: `refusal` is the routed model's content_filter finish.",
  },
} as const satisfies Record<
  TanStackAIProvider,
  string | { notApplicable: string }
>;

/**
 * `shape` as `provider` streams it, from the provider's cassettes; or why
 * the provider's protocol cannot stream it.
 */
export const shapeAnswerOf = (
  cassettes: readonly ProviderWireCassette[],
  provider: TanStackAIProvider,
  shape: ResponseShape,
): ShapeAnswer | { notApplicable: string } => {
  const text = cassetteFor(cassettes, provider, "text");
  const emptied = (with_: string): ProviderWireExchange[] =>
    withAnswerText(provider, text.exchanges, with_);
  switch (shape) {
    case "text":
      return scenarioAnswer(cassettes, provider, "text");
    case "empty":
      return {
        exchanges: emptied(""),
        reasoning: false,
        verdict: { finishReason: "stop", kind: "nothing" },
      };
    case "whitespace":
      return {
        exchanges: emptied(" \n\n "),
        reasoning: false,
        verdict: { finishReason: "stop", kind: "nothing" },
      };
    case "reasoning-only":
      return {
        exchanges: withReasoning(provider, { ...text, exchanges: emptied("") }),
        reasoning: true,
        verdict: { finishReason: "stop", kind: "nothing" },
      };
    case "tool-call":
      return {
        exchanges: sourceOf(cassettes, provider, "tool-call").exchanges,
        reasoning: false,
        verdict: { kind: "card" },
      };
    case "tool-call-then-empty":
      return {
        exchanges: [
          ...renamed(
            sourceOf(cassettes, provider, "tool-call").exchanges,
            WIRE_TOOL_NAME,
            PLAIN_TOOL_NAME,
          ),
          ...emptied(""),
        ],
        reasoning: false,
        verdict: { kind: "ran-call" },
      };
    case "structured-output-empty":
      return {
        notApplicable:
          "No chat surface requests structured output: `streamChat` passes no outputSchema, and the title, recap, suggestion and subagent builders generate text.",
      };
    case "length":
      return scenarioAnswer(cassettes, provider, "length");
    case "refusal":
      return scenarioAnswer(cassettes, provider, "refusal");
    case "content-filter": {
      const variant = CONTENT_FILTER_VARIANT[provider];
      if (typeof variant !== "string") {
        return variant;
      }
      const cassette = sourceOf(cassettes, provider, "refusal", variant);
      return {
        exchanges: cassette.exchanges,
        reasoning: false,
        verdict: verdictOf(provider, cassette),
      };
    }
    case "mid-stream-error":
      return scenarioAnswer(cassettes, provider, "malformed-chunk");
    case "early-eof":
      return scenarioAnswer(cassettes, provider, "early-eof");
    case "duplicate-terminal":
      return {
        exchanges: withDuplicateTerminal(text.exchanges),
        reasoning: false,
        verdict: verdictOf(provider, text),
      };
    case "text-terminal-only":
      return scenarioAnswer(cassettes, provider, "text-terminal-only");
    case "unusable-stop":
      return scenarioAnswer(cassettes, provider, "unusable-stop");
    case "unlisted-stop":
      return scenarioAnswer(cassettes, provider, "unlisted-stop");
    case "fails-before-output":
      return scenarioAnswer(cassettes, provider, "bad-request");
    default:
      shape satisfies never;
      return panic(`Unhandled shape: ${String(shape)}`);
  }
};

/**
 * `cassette`, a text answer of `provider`, with nothing in it and no output
 * tokens: what both readings of an empty completion (the content the attempt
 * streamed, and the provider's token count) take as one, so the fallback
 * runs whichever the attempt reads.
 */
export const silentAnswerOf = (
  provider: TanStackAIProvider,
  cassette: ProviderWireCassette,
): ProviderWireCassette =>
  emptyCompletionAnswer({
    ...cassette,
    exchanges: withAnswerText(provider, cassette.exchanges, ""),
  });

// --- Expected settlement --------------------------------------------------------

/** How a turn must settle: its status, and for a failure its code (where
 *  one is owed) and whether it can be retried. */
export type ExpectedSettlement =
  | { status: Exclude<ChatTurnStatus, "failed"> }
  | {
      failureCode: ChatTurnFailureCode | "any";
      failureRetryable: boolean | "any";
      status: "failed";
    };

/**
 * What a turn whose run `verdict` answers must settle as, from `position`:
 * an answer or a call the loop ran completes it, a card makes it wait, a
 * failure fails it, and a run that added nothing fails it retryably, as an
 * empty response when the provider stopped normally. After a tool the loop
 * ran, the run already shows that call.
 */
export const expectedSettlement = (
  verdict: ShapeVerdict,
  position: TurnPosition,
): ExpectedSettlement => {
  const kind = verdict.kind;
  switch (kind) {
    case "answer":
    case "ran-call":
      return { status: "completed" };
    case "card":
      return { status: "awaiting-user" };
    case "failure":
      return { failureCode: "any", failureRetryable: "any", status: "failed" };
    case "nothing":
      if (position === "after-tool-result") {
        return { status: "completed" };
      }
      return {
        failureCode: verdict.finishReason === "stop" ? "empty-response" : "any",
        failureRetryable: true,
        status: "failed",
      };
    default:
      kind satisfies never;
      return panic(`Unhandled verdict: ${String(kind)}`);
  }
};

// --- Combinations ---------------------------------------------------------------

/** One chat turn: the provider whose adapter reads the answer, where the
 *  turn starts, and the shape of the answer. */
export type TurnCombination = {
  position: TurnPosition;
  provider: TanStackAIProvider;
  shape: ResponseShape;
};

/** One builder beside the chat, answered by one shape. */
export type SurfaceCombination = {
  provider: TanStackAIProvider;
  shape: ResponseShape;
  surface: Surface;
};

export const turnCombinationKey = ({
  position,
  provider,
  shape,
}: TurnCombination): string => `${shape} from ${position} on ${provider}`;

export const turnCombinationValues = ({
  position,
  provider,
  shape,
}: TurnCombination): readonly string[] => [shape, position, provider];

export const surfaceCombinationValues = ({
  provider,
  shape,
  surface,
}: SurfaceCombination): readonly string[] => [shape, surface, provider];

export const surfaceCombinationKey = ({
  provider,
  shape,
  surface,
}: SurfaceCombination): string => `${shape} for ${surface} on ${provider}`;

type Excluded<Combination> = { combination: Combination; predicate: string };

/** The model a provider's conversations run on here: its recorded one. */
export const chatModelOf = (
  cassettes: readonly ProviderWireCassette[],
  provider: TanStackAIProvider,
): string => modelOf(cassettes, { provider, slot: "recorded" });

/** The predicates that exclude a turn combination, by name. */
const TURN_PREDICATES: Readonly<
  Record<
    string,
    (
      combination: TurnCombination,
      cassettes: readonly ProviderWireCassette[],
    ) => boolean
  >
> = {
  /** The subagent's own run is the `subagent` surface's: its answer reaches
   *  the user through its parent's tool result, not a turn of its own. */
  "position: runSubagent answers its parent, not a turn": ({ position }) =>
    position !== "subagent-child",
  /** A fallback runs only on a reasoning model other than the chat model
   *  (`resolveFallbackTextModel`). */
  "attempt: resolveFallbackTextModel": ({ position, provider }, cassettes) =>
    position !== "fallback" ||
    reasoningModelOf(provider, chatModelOf(cassettes, provider)) !==
      chatModelOf(cassettes, provider),
};

/** Every turn combination, split by what the product can produce. */
export const enumerateTurnCombinations = (
  cassettes: readonly ProviderWireCassette[],
): {
  excluded: Excluded<TurnCombination>[];
  included: TurnCombination[];
} => {
  const included: TurnCombination[] = [];
  const excluded: Excluded<TurnCombination>[] = [];
  for (const combination of product({
    position: TURN_POSITION_NAMES,
    provider: TANSTACK_AI_PROVIDERS,
    shape: RESPONSE_SHAPE_NAMES,
  })) {
    const answer = shapeAnswerOf(
      cassettes,
      combination.provider,
      combination.shape,
    );
    const refused =
      "notApplicable" in answer
        ? `shape: ${answer.notApplicable}`
        : Object.entries(TURN_PREDICATES).find(
            ([, allows]) => !allows(combination, cassettes),
          )?.[0];
    if (refused === undefined) {
      included.push(combination);
    } else {
      excluded.push({ combination, predicate: refused });
    }
  }
  return { excluded, included };
};

/** Every surface combination, split by what the product can produce. */
export const enumerateSurfaceCombinations = (
  cassettes: readonly ProviderWireCassette[],
): {
  excluded: Excluded<SurfaceCombination>[];
  included: SurfaceCombination[];
} => {
  const included: SurfaceCombination[] = [];
  const excluded: Excluded<SurfaceCombination>[] = [];
  for (const combination of product({
    provider: TANSTACK_AI_PROVIDERS,
    shape: RESPONSE_SHAPE_NAMES,
    surface: SURFACE_NAMES,
  })) {
    const answer = shapeAnswerOf(
      cassettes,
      combination.provider,
      combination.shape,
    );
    if ("notApplicable" in answer) {
      excluded.push({
        combination,
        predicate: `shape: ${answer.notApplicable}`,
      });
    } else {
      included.push(combination);
    }
  }
  return { excluded, included };
};
