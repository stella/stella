import * as v from "valibot";

import { STELLA_API_VERSION_PREFIX } from "./api-version";
import {
  CHAT_LOCAL_RUN_STEP_MAX_BYTES,
  type ChatLocalRunStepKind,
} from "./chat-local-run-step-output";
import { chatLocalRunFileSchema } from "./chat-run-target";
import { DESKTOP_RUNNER_LIMITS } from "./desktop-runner";

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
 * - `not_copied`: the thread is a fork that holds nothing for a step its
 *   source thread still stores: the copy made with the fork did not finish,
 *   and asking for the same fork again completes it.
 * - `not_stored`: nothing stored and nothing will be.
 */
export const CHAT_LOCAL_RUN_STEP_CONTENT_STATE = {
  stored: "stored",
  tooLarge: "too_large",
  runBudgetReached: "run_budget_reached",
  arriving: "arriving",
  notCopied: "not_copied",
  notStored: "not_stored",
} as const;
export type ChatLocalRunStepContentState =
  (typeof CHAT_LOCAL_RUN_STEP_CONTENT_STATE)[keyof typeof CHAT_LOCAL_RUN_STEP_CONTENT_STATE];

/** The states a stored row holds; the others say there is no row. */
export const CHAT_LOCAL_RUN_STEP_CONTENT_STORED_STATES = [
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored,
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE.tooLarge,
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE.runBudgetReached,
] as const;
export type ChatLocalRunStepContentStoredState =
  (typeof CHAT_LOCAL_RUN_STEP_CONTENT_STORED_STATES)[number];

/**
 * What a stored row may say of its step: how it settled, or `awaited` while
 * its run, now over, has still to send it (see the announcement below).
 */
export const CHAT_LOCAL_RUN_STEP_CONTENT_ROW_OUTCOMES = [
  ...CHAT_LOCAL_RUN_STEP_CONTENT_STORED_STATES,
  "awaited",
] as const;

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

/**
 * The code of a refusal to write a step that already settled: a step is
 * stored once, by the run that produced it, and nothing rewrites it. The
 * computer must not send the step again.
 */
export const CHAT_LOCAL_RUN_STEP_CONTENT_CONFLICT_CODE =
  "step_content_conflict";

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
    state: v.literal(CHAT_LOCAL_RUN_STEP_CONTENT_STATE.notCopied),
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

/**
 * Whether a fork holds the stored content of the steps it copied. The fork
 * exists either way; `incomplete` means the copy of its steps' content did
 * not finish, and the same fork request sent again completes it.
 */
export const CHAT_FORK_STEP_CONTENT = {
  complete: "complete",
  incomplete: "incomplete",
} as const;
export type ChatForkStepContent =
  (typeof CHAT_FORK_STEP_CONTENT)[keyof typeof CHAT_FORK_STEP_CONTENT];

/**
 * What a run could not send by its end. A run that is over takes nothing
 * more, with one exception it must name itself while it is still going: just
 * before its finish it announces the keys of the steps whose content it
 * still holds, and those steps alone may be sent later.
 *
 * The announcement carries keys and nothing of a step's content. Past
 * `CHAT_LOCAL_RUN_STEPS_AWAITED_MAX` keys it says only how many more there
 * were; those steps are not awaited and read as not stored.
 */
export const CHAT_LOCAL_RUN_STEPS_AWAITED_EVENT = "stella.run-steps-awaited";

export const CHAT_LOCAL_RUN_STEPS_AWAITED_MAX = 2000;

export const chatLocalRunStepsAwaitedSchema = v.strictObject({
  stepKeys: v.pipe(
    v.array(chatLocalRunStepKeySchema),
    v.maxLength(CHAT_LOCAL_RUN_STEPS_AWAITED_MAX),
  ),
  /** How many steps past the bound the run still held; they are not awaited. */
  more: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
export type ChatLocalRunStepsAwaited = v.InferOutput<
  typeof chatLocalRunStepsAwaitedSchema
>;

/**
 * How long after the announcement an awaited step may still be sent: as long
 * as a run waits for its computer to return. Inside it a reader is told the
 * step is still arriving; after it, that nothing was stored.
 */
export const CHAT_LOCAL_RUN_STEP_AWAITED_MS =
  DESKTOP_RUNNER_LIMITS.abandonedRunMs;

/**
 * Where a computer sends an awaited step of a run that is over. The computer
 * itself is the caller: its linked account's credential with a proof by the
 * device key, the same installation and key the run ran on.
 */
export const chatLocalRunAwaitedStepContentPath = (
  runId: string,
  stepKey: string,
) =>
  `${STELLA_API_VERSION_PREFIX}/desktop/runner/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepKey)}/content` as const;

/**
 * Why a step sent after its run's end is refused for good:
 *
 * - `step_not_awaited`: the run never announced the step, or it is settled.
 * - `step_window_closed`: the step was awaited, and its time has passed.
 * - `run_on_another_computer`: the run ran on another installation or under
 *   another device key (a computer linked again is another computer).
 */
export const CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL = {
  notAwaited: "step_not_awaited",
  windowClosed: "step_window_closed",
  otherComputer: "run_on_another_computer",
} as const;
export type ChatLocalRunAwaitedStepRefusal =
  (typeof CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL)[keyof typeof CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL];
