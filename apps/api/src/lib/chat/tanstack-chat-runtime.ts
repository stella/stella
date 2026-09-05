// The one module that starts a TanStack `chat()` run, and the one that reads
// a key off a chunk that run produced.
//
// `chat()` emits its public chunks in AG-UI spec shape: `normalizeStreamChunk`
// keeps only the spec keys of the event type and moves the rest into
// `metadata.tanstack`, dropping a few outright. Two production defects came
// from reading a moved key at the top level of an engine-emitted chunk, so the
// engine's output is typed as `PublicStreamChunk` — the same union with those
// keys removed from the members that declare them — and every read of one goes
// through a reader here. A consumer that spells `chunk.finishReason` no longer
// compiles.

import { chat } from "@tanstack/ai";
import type {
  ChatMiddleware,
  RunFinishedEvent,
  SchemaInput,
  StreamChunk,
  StructuredOutputStream,
} from "@tanstack/ai";

import { isRecord } from "@/api/lib/type-guards";

/**
 * Top-level keys `normalizeStreamChunk` takes off an engine-emitted chunk, per
 * event type. Some are moved into `metadata.tanstack` and some are dropped;
 * `tanstack-chat-runtime.test.ts` pins which, in both directions, against the
 * installed SDK.
 *
 * The domain is the event types the engine touches, not every event type: a
 * type it leaves whole has nothing to record here, and a row of `[]` would say
 * only that nobody looked. `Extract` still binds every name to a real event,
 * so a misspelled one drops out of the domain and lands as an excess key.
 *
 * The keys are written as plain strings rather than `EventType` members. Some
 * members of `StreamChunk` discriminate on the enum and some on a bare string
 * literal, and an enum-keyed table is unreachable from the literal spelling.
 */
type StrippedChunkType = Extract<
  `${StreamChunk["type"]}`,
  | "RUN_ERROR"
  | "RUN_FINISHED"
  | "TEXT_MESSAGE_CONTENT"
  | "TOOL_CALL_ARGS"
  | "TOOL_CALL_END"
  | "TOOL_CALL_START"
>;

export const STRIPPED_CHUNK_KEYS = {
  RUN_FINISHED: ["finishReason", "model"],
  RUN_ERROR: ["error", "finishReason", "model", "runId", "threadId"],
  TOOL_CALL_START: ["toolName"],
  TOOL_CALL_END: ["input", "output", "result", "state", "toolName"],
  // The engine skips this trio wholesale on the two high-frequency delta
  // events, so both rows carry all three whether or not an adapter sets them.
  TEXT_MESSAGE_CONTENT: ["args", "content", "model"],
  TOOL_CALL_ARGS: ["args", "content", "model"],
} as const satisfies Record<StrippedChunkType, readonly string[]>;

type StrippedChunkKeys = typeof STRIPPED_CHUNK_KEYS;

type StrippedKeysFor<TType> = TType extends keyof StrippedChunkKeys
  ? StrippedChunkKeys[TType][number]
  : never;

// AG-UI's `BaseEvent` carries `[k: string]: unknown`, so a member that extends
// it already answers any key read, and `Omit` over one collapses it into a
// bare index signature that no longer discriminates the union. Those members
// pass through untouched. The members TanStack declares field by field — the
// ones a non-spec read can compile against — lose the keys the engine takes.
type StrippedFrom<TChunk, TType> = string extends keyof TChunk
  ? never
  : Extract<StrippedKeysFor<TType>, keyof TChunk>;

type PublicChunk<TChunk> = TChunk extends { type: infer TType }
  ? [StrippedFrom<TChunk, TType>] extends [never]
    ? TChunk
    : Omit<TChunk, StrippedFrom<TChunk, TType>>
  : never;

/**
 * A chunk in the shape `chat()` hands it out. Assignable to and from
 * `StreamChunk` — every stripped field is optional in the SDK types — so this
 * is a reading discipline rather than a barrier: it makes the top-level read
 * of a moved key a compile error and says nothing about where a chunk travels.
 */
export type PublicStreamChunk = PublicChunk<StreamChunk>;

/**
 * One member of `PublicStreamChunk`, by event type. The template literal
 * accepts either spelling of a discriminant: `StreamChunk` mixes members that
 * discriminate on an `EventType` member with members that discriminate on a
 * bare string literal, and an enum member is not interchangeable with its
 * literal in a type position.
 */
export type PublicChunkOfType<TType extends `${StreamChunk["type"]}`> = Extract<
  PublicStreamChunk,
  { type: TType }
>;

export type PublicRunFinishedChunk = PublicChunkOfType<"RUN_FINISHED">;
export type PublicToolCallStartChunk = PublicChunkOfType<"TOOL_CALL_START">;
export type PublicToolCallEndChunk = PublicChunkOfType<"TOOL_CALL_END">;

/** How a text run ended, as `RUN_FINISHED` reports it. */
export type TanStackTextFinishReason = Exclude<
  RunFinishedEvent["finishReason"],
  undefined
>;

// Top level first, then `metadata.tanstack`: the precedence the SDK's own
// `StreamProcessor` applies. A chunk that never went through the engine (a
// fixture, an event this service synthesises) carries the value at the top
// level, and so does one this service transformed and re-emitted.
const readEngineField = (chunk: object, key: string): unknown => {
  if (key in chunk) {
    const topLevel: unknown = Reflect.get(chunk, key);
    if (topLevel !== undefined) {
      return topLevel;
    }
  }
  const metadata: unknown = Reflect.get(chunk, "metadata");
  const tanstack: unknown = isRecord(metadata)
    ? metadata["tanstack"]
    : undefined;
  return isRecord(tanstack) ? tanstack[key] : undefined;
};

export const finishReasonOf = (
  chunk: PublicRunFinishedChunk,
): TanStackTextFinishReason => {
  const engineChunk: RunFinishedEvent = chunk;
  return (
    engineChunk.finishReason ??
    engineChunk.metadata?.tanstack?.finishReason ??
    null
  );
};

/** Parsed tool arguments. Anthropic delivers these on `TOOL_CALL_END` only. */
export const toolCallEndInputOf = (chunk: PublicToolCallEndChunk): unknown =>
  readEngineField(chunk, "input");

export const toolCallEndOutputOf = (chunk: PublicToolCallEndChunk): unknown =>
  readEngineField(chunk, "output");

/**
 * `TOOL_CALL_START` carries the tool name as the spec key `toolCallName`, with
 * `toolName` as the alias the engine folds into it. `TOOL_CALL_END` carries
 * neither, so `metadata.tanstack.toolName` is the only place a name appears.
 */
export const toolCallNameOf = (
  chunk: PublicToolCallStartChunk | PublicToolCallEndChunk,
): string | undefined => {
  const name =
    readEngineField(chunk, "toolCallName") ??
    readEngineField(chunk, "toolName");
  return typeof name === "string" ? name : undefined;
};

// `chat()` resolves seven type parameters from its argument and exports none
// of the option types it builds them from, so a generic pass-through would
// have to re-declare the whole signature. These wrappers take the options type
// with those parameters at their constraints instead: every option the call
// sites pass still type-checks, and only the adapter-specific narrowing of
// `messages` and `modelOptions` widens.
//
// `middleware` is the exception. At the constraint it collapses to `never`,
// because the SDK builds it from the inferred middleware tuple to run a
// capability-coverage check whose marker type the package does not export.
// The exported element type stands in its place: a middleware that declared a
// `requires` name would no longer be checked against the array's providers.
// No middleware in this repository declares one, and the pair that has to
// travel together (the sandbox adapter and its capability) is returned as a
// pair by its owner rather than assembled at the call site.
type ChatOptions = Omit<Parameters<typeof chat>[0], "middleware"> & {
  middleware?: ChatMiddleware[];
};

/** The streaming text form. `stream` and `outputSchema` belong to the owner. */
export type StreamChatChunksOptions = Omit<
  ChatOptions,
  "outputSchema" | "stream"
>;

export const streamChatChunks = (
  options: StreamChatChunksOptions,
): AsyncIterable<PublicStreamChunk> => chat(options);

/** The awaited text form: the run's collected assistant text. */
export const generateChatText = async (
  options: StreamChatChunksOptions,
): Promise<string> => await chat({ ...options, stream: false });

export type ChatObjectOptions = StreamChatChunksOptions & {
  outputSchema: SchemaInput;
};

/**
 * The awaited structured-output form. The engine validates against the schema
 * it was handed; callers parse the result with their own schema, so it stays
 * `unknown` here.
 */
export const generateChatObject = async (
  options: ChatObjectOptions,
): Promise<unknown> => await chat(options);

type StructuredOutputStreamChunk =
  StructuredOutputStream extends AsyncIterable<infer TChunk> ? TChunk : never;

export type PublicStructuredOutputChunk =
  PublicChunk<StructuredOutputStreamChunk>;

/**
 * The streaming structured-output form: JSON deltas on
 * `TEXT_MESSAGE_CONTENT`, then a terminal `structured-output.complete`.
 */
export const streamChatObject = (
  options: ChatObjectOptions,
): AsyncIterable<PublicStructuredOutputChunk> =>
  chat({ ...options, stream: true });
