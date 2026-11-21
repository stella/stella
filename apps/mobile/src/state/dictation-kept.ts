import { panic, TaggedError } from "better-result";
import * as v from "valibot";

import { AI_FAILURE_CODES } from "@stll/api-contract/ai-errors";

import type { ApiError } from "@/state/api-request";
import { modelClassSchema } from "@/state/dictation-fallback";
import type { ModelClass } from "@/state/dictation-fallback";

/**
 * A dictation that could not be transcribed is kept on the phone, never
 * lost: its recordings wait in an app-private folder until they are
 * transcribed, by themselves once the phone is online again or when the
 * person retries, or until the person discards them. Its text then goes to
 * the field it was dictated into, or, with that field closed, is offered
 * for pasting into another of its kind for a while.
 */

/** The kinds of field a dictation is for, which a recovered text is offered in. */
const DICTATION_FIELDS = ["chat", "message", "task", "timer"] as const;

export type DictationField = (typeof DICTATION_FIELDS)[number];

/** How long a recovered text whose field was closed is offered for pasting. */
export const RECOVERED_OFFER_MS = 10 * 60 * 1000;

/** One piece of a kept dictation, in spoken order. */
export type KeptPiece =
  /** Transcribed already. */
  | { readonly type: "text"; readonly text: string }
  /** The recording still to transcribe: a file in the dictation's folder. */
  | { readonly type: "audio"; readonly file: string };

/** Why a refused dictation waits, where the person can do more than retry. */
const KEPT_REFUSALS = ["model"] as const;

export type KeptRefusal = (typeof KEPT_REFUSALS)[number];

/** Where a kept dictation stands. */
type KeptState =
  | {
      readonly type: "waiting";
      readonly pieces: readonly KeptPiece[];
      /** Refused, or unreadable: tried again only when the person retries. */
      readonly refused: boolean;
      /** `model`: refused because the picked model is no longer offered. */
      readonly refusedFor: KeptRefusal | null;
    }
  | {
      readonly type: "recovered";
      readonly text: string;
      /** The matter's names it was transcribed with, for how it is pasted. */
      readonly names: readonly string[];
      readonly recoveredAt: number;
    };

/**
 * A kept dictation with what it is transcribed with, as when it was
 * recorded: the account, the matter whose names the model expects, the
 * model, and the language and cleanup choice of its text.
 */
export type KeptDictation = {
  readonly id: string;
  readonly serverUrl: string;
  readonly userId: string;
  readonly field: DictationField;
  readonly matterId: string | null;
  readonly modelId: string | null;
  readonly modelClass: ModelClass | null;
  readonly locale: string;
  readonly cleanup: boolean;
  readonly keptAt: number;
  readonly state: KeptState;
};

const pieceSchema = v.variant("type", [
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({
    type: v.literal("audio"),
    // A file name inside the dictation's own folder, never a path.
    file: v.pipe(v.string(), v.regex(/^[\w.-]+$/u)),
  }),
]);

export const keptDictationSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^[\w-]+$/u)),
  serverUrl: v.string(),
  userId: v.string(),
  field: v.picklist(DICTATION_FIELDS),
  matterId: v.nullable(v.string()),
  modelId: v.nullable(v.string()),
  // Kept before the class was: unknown, so a withdrawn model falls back to
  // none.
  modelClass: v.optional(v.nullable(modelClassSchema), null),
  locale: v.string(),
  cleanup: v.boolean(),
  keptAt: v.number(),
  state: v.variant("type", [
    v.object({
      type: v.literal("waiting"),
      pieces: v.array(pieceSchema),
      refused: v.boolean(),
      // Kept before the reason was: no reason of its own.
      refusedFor: v.optional(v.nullable(v.picklist(KEPT_REFUSALS)), null),
    }),
    v.object({
      type: v.literal("recovered"),
      text: v.string(),
      names: v.array(v.string()),
      recoveredAt: v.number(),
    }),
  ]),
});

/** A recording on the phone could not be read for its transcription. */
export class RecordingReadError extends TaggedError("RecordingReadError")<{
  message: string;
  cause?: unknown;
}> {}

/** Why one recording gave no text. */
export type PieceFailure = ApiError | RecordingReadError;

/** Whether a kept dictation belongs to the signed-in account. */
export const keptFor = (
  kept: KeptDictation,
  account: { readonly serverUrl: string; readonly userId: string },
): boolean =>
  kept.serverUrl === account.serverUrl && kept.userId === account.userId;

/**
 * Whether a failed transcription is tried again by itself: the phone was
 * offline, the server busy or down, or the sign-in could not be refreshed.
 * A refusal of the recording, or one the phone cannot read, waits for the
 * person to retry or discard it.
 */
export const retriesByItself = (error: PieceFailure): boolean => {
  switch (error._tag) {
    case "ApiRequestError":
      // The picked model is not served at all: trying it again by itself
      // would only fail again until the person retries or picks another.
      if (error.code !== undefined && MODEL_UNSERVED_CODES.has(error.code)) {
        return false;
      }
      return (
        error.status === undefined ||
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500
      );
    case "TokenError":
      return true;
    case "SignedOutError":
    case "RecordingReadError":
      return false;
    default:
      error satisfies never;
      return panic("A transcription failed with an error of no known kind");
  }
};

/** Why a failure waits for the person: `model` when the picked model is not served. */
export const refusalOf = (error: PieceFailure): KeptRefusal | null =>
  error._tag === "ApiRequestError" &&
  error.code !== undefined &&
  MODEL_UNSERVED_CODES.has(error.code)
    ? "model"
    : null;

/** What the server answers for a model it does not serve in the organization's region. */
const MODEL_UNSERVED_CODES: ReadonlySet<string> = new Set([
  "transcription_model_unavailable",
  AI_FAILURE_CODES.managed_provider_unavailable,
]);

const FIRST_RETRY_MS = 30_000;
const LONGEST_RETRY_MS = 10 * 60 * 1000;

/**
 * How long a kept dictation waits before it is tried again by itself after
 * `failures` tries in a row failed: half a minute, doubling up to ten.
 */
export const retryDelayMs = (failures: number): number =>
  Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1), LONGEST_RETRY_MS);

/** Whether a recovered text is still offered at `now`. */
export const stillOffered = (kept: KeptDictation, now: number): boolean =>
  kept.state.type === "recovered" &&
  now - kept.state.recoveredAt < RECOVERED_OFFER_MS;

/** The recordings of a waiting dictation still to transcribe, in spoken order. */
export const recordingsToTranscribe = (
  pieces: readonly KeptPiece[],
): string[] =>
  pieces.flatMap((piece) => (piece.type === "audio" ? [piece.file] : []));

/**
 * The pieces once a retry has transcribed some of them: each recording
 * with a text becomes that text, the others stay recordings.
 */
export const withTranscribed = (
  pieces: readonly KeptPiece[],
  texts: ReadonlyMap<string, string>,
): KeptPiece[] =>
  pieces.map((piece) => {
    if (piece.type === "text") {
      return piece;
    }
    const text = texts.get(piece.file);
    return text === undefined ? piece : { type: "text", text };
  });

/** Every piece's text in spoken order, or null while a recording is left. */
export const transcribedTexts = (
  pieces: readonly KeptPiece[],
): string[] | null => {
  const texts: string[] = [];
  for (const piece of pieces) {
    if (piece.type === "audio") {
      return null;
    }
    texts.push(piece.text);
  }
  return texts;
};
