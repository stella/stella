import * as v from "valibot";

import { STELLA_API_VERSION_PREFIX } from "./api-version";
import {
  CHAT_LOCAL_RUN_STEP_MAX_BYTES,
  type ChatLocalRunStepKind,
} from "./chat-local-run-step-output";
import { chatLocalRunFileSchema } from "./chat-run-target";

/**
 * What a coding agent's step produced on the member's computer (a command's
 * output, a change's diff, a subagent's own conversation, an image it
 * viewed), as stella stores it: beside the step's call, never in the call,
 * its result or the run's stream. The computer's sidecar sends each step's
 * content to the API with the run's own agent token; the API keeps it with
 * the conversation, for the member who owns it, and a page or phone reads one
 * step by its chat call id.
 *
 * Text is held encrypted for the member's organization, which is stricter
 * than a tool result stored in a message: it comes from files on a member's
 * computer. An image is stored as a chat file.
 */

export const CHAT_LOCAL_RUN_STEP_CONTENT_KINDS = [
  "command",
  "diff",
  "conversation",
  "image",
] as const;
export type ChatLocalRunStepContentKind =
  (typeof CHAT_LOCAL_RUN_STEP_CONTENT_KINDS)[number];

export type ChatLocalRunStepTextKind = Exclude<
  ChatLocalRunStepContentKind,
  "image"
>;

/** Which per-step cap (`CHAT_LOCAL_RUN_STEP_MAX_BYTES`) holds a kind. */
export const chatLocalRunStepContentCap = (
  kind: ChatLocalRunStepContentKind,
): number => {
  const capKind: ChatLocalRunStepKind = kind === "image" ? "image" : "text";
  return CHAT_LOCAL_RUN_STEP_MAX_BYTES[capKind];
};

/**
 * The most one run stores of its steps' content: bytes of text, and images.
 * Past either, a step's content is not stored and the step says so
 * (`run_budget_reached`). An image also counts toward its organization's
 * file storage, as any chat file does.
 */
export const CHAT_LOCAL_RUN_STEP_CONTENT_RUN_BUDGET = {
  textBytes: 64 * 1024 * 1024,
  images: 100,
} as const;

/**
 * Where a step's content stands.
 *
 * - `stored`: kept, whole or (a text past its cap) its start.
 * - `too_large`: an image past its cap; only its size is kept.
 * - `run_budget_reached`: the run had stored all it may before this step.
 * - `arriving`: nothing stored yet and the step's run is still going, so the
 *   computer may yet send it.
 * - `not_stored`: nothing stored and nothing will be.
 */
export const CHAT_LOCAL_RUN_STEP_CONTENT_STATE = {
  stored: "stored",
  tooLarge: "too_large",
  runBudgetReached: "run_budget_reached",
  arriving: "arriving",
  notStored: "not_stored",
} as const;
export type ChatLocalRunStepContentState =
  (typeof CHAT_LOCAL_RUN_STEP_CONTENT_STATE)[keyof typeof CHAT_LOCAL_RUN_STEP_CONTENT_STATE];

/** The states a stored row holds; the other two say there is no row. */
export const CHAT_LOCAL_RUN_STEP_CONTENT_STORED_STATES = [
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored,
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE.tooLarge,
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE.runBudgetReached,
] as const;
export type ChatLocalRunStepContentStoredState =
  (typeof CHAT_LOCAL_RUN_STEP_CONTENT_STORED_STATES)[number];

/**
 * A step's key: the SHA-256 hex of its chat call id, so a path names no
 * harness id.
 */
export const chatLocalRunStepKeySchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{64}$/u),
);

/** Where the computer sends one step's content, with the run's agent token. */
export const chatLocalRunStepContentUploadPath = (
  runId: string,
  stepKey: string,
) =>
  `${STELLA_API_VERSION_PREFIX}/chat/local-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepKey)}/content` as const;

const byteCountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/**
 * The code of a refusal of content the computer must not send again: text
 * that is not UTF-8, bytes that are no image, more than a kind keeps.
 */
export const CHAT_LOCAL_RUN_STEP_CONTENT_INVALID_CODE = "step_content_invalid";

/** What the API answers once it settled a step's content. */
export const chatLocalRunStepContentUploadedSchema = v.strictObject({
  state: v.picklist(CHAT_LOCAL_RUN_STEP_CONTENT_STORED_STATES),
});

/**
 * How much of a stored text one read answers: `defaultBytes` unless the
 * reader asks for another amount, never more than the text cap.
 */
export const CHAT_LOCAL_RUN_STEP_CONTENT_WINDOW = {
  defaultBytes: 64 * 1024,
  maxBytes: CHAT_LOCAL_RUN_STEP_MAX_BYTES.text,
} as const;

const TEXT_KINDS = [
  "command",
  "diff",
  "conversation",
] as const satisfies readonly ChatLocalRunStepTextKind[];

const unstoredFields = {
  kind: v.picklist(CHAT_LOCAL_RUN_STEP_CONTENT_KINDS),
  /** How many bytes the step produced. */
  totalBytes: byteCountSchema,
};

/** What one read of a step's content answers. */
export const chatLocalRunStepContentSchema = v.variant("state", [
  v.variant("kind", [
    v.strictObject({
      state: v.literal(CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored),
      kind: v.picklist(TEXT_KINDS),
      totalBytes: byteCountSchema,
      /** How many bytes are stored; fewer than `totalBytes` past the cap. */
      storedBytes: byteCountSchema,
      /** Where `text` starts among the stored bytes. */
      start: byteCountSchema,
      text: v.string(),
      /** Where the next read starts; `null` once the stored text ended. */
      nextStart: v.nullable(byteCountSchema),
    }),
    v.strictObject({
      state: v.literal(CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored),
      kind: v.literal("image"),
      totalBytes: byteCountSchema,
      file: chatLocalRunFileSchema,
    }),
  ]),
  v.strictObject({
    state: v.literal(CHAT_LOCAL_RUN_STEP_CONTENT_STATE.tooLarge),
    ...unstoredFields,
  }),
  v.strictObject({
    state: v.literal(CHAT_LOCAL_RUN_STEP_CONTENT_STATE.runBudgetReached),
    ...unstoredFields,
  }),
  v.strictObject({
    state: v.literal(CHAT_LOCAL_RUN_STEP_CONTENT_STATE.arriving),
  }),
  v.strictObject({
    state: v.literal(CHAT_LOCAL_RUN_STEP_CONTENT_STATE.notStored),
  }),
]);
export type ChatLocalRunStepContent = v.InferOutput<
  typeof chatLocalRunStepContentSchema
>;

const isContinuationByte = (byte: number | undefined) =>
  byte !== undefined && byte >= 0x80 && byte < 0xc0;

/** The nearest character boundary of UTF-8 `bytes` at or before `at`. */
const boundaryAtOrBefore = (bytes: Uint8Array, at: number) => {
  let boundary = Math.min(Math.max(at, 0), bytes.length);
  while (
    boundary > 0 &&
    boundary < bytes.length &&
    isContinuationByte(bytes[boundary])
  ) {
    boundary -= 1;
  }
  return boundary;
};

type Utf8Window = { start: number; end: number; nextStart: number | null };

/**
 * The window of UTF-8 `bytes` one read answers: whole characters from
 * `from`, at most `limit` bytes of them. A position inside a character
 * starts at that character, so windows read in order from each `nextStart`
 * rejoin to the stored text. A window always moves forward: where `limit` is
 * shorter than the character at `from`, it holds that one character.
 */
export const chatLocalRunStepContentWindow = (
  bytes: Uint8Array,
  from: number,
  limit: number,
): Utf8Window => {
  const start = boundaryAtOrBefore(bytes, from);
  let end = boundaryAtOrBefore(bytes, start + Math.max(limit, 1));
  if (end <= start && start < bytes.length) {
    end = start + 1;
    while (end < bytes.length && isContinuationByte(bytes[end])) {
      end += 1;
    }
  }
  return { start, end, nextStart: end < bytes.length ? end : null };
};
