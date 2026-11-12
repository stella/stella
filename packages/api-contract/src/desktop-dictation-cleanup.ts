import * as v from "valibot";

import contract from "./desktop-dictation-cleanup.json";
import { STELLA_API_VERSION_PREFIX } from "./index";

// desktop-dictation-cleanup.json carries the same values for the native
// client; desktop-dictation-cleanup.test.ts binds the two.
export const DESKTOP_DICTATION_CLEANUP_PATH =
  `${STELLA_API_VERSION_PREFIX}/desktop/dictation/cleanup` as const;

export const DESKTOP_DICTATION_CLEANUP_LIMITS = {
  transcriptLength: contract.maxTranscriptLength,
  localeLength: contract.maxLocaleLength,
  languages: contract.maxLanguages,
  segments: contract.maxSegments,
} as const;

/** How far a cleaned answer may shrink from what was dictated. Cleanup
 *  drops spoken commands and fixes spellings, so the transcript is measured
 *  by its letters and digits outside `commandWords`. An answer that keeps
 *  less than this share of them, or breaks a line far more often than the
 *  dictation could have asked for, lost content and is replaced by the raw
 *  transcript. A dictation of commands only may be answered by breaks only. */
export const DESKTOP_DICTATION_CLEANUP_PLAUSIBILITY = {
  commandWords: contract.commandWords,
  minAnswerTextPercent: contract.minAnswerTextPercent,
  minBreakAllowance: contract.minBreakAllowance,
  transcriptCharactersPerBreak: contract.transcriptCharactersPerBreak,
} as const;

/** Characters the desktop never types: controls, the Unicode line and
 *  paragraph separators, and the bidirectional embedding, override and
 *  isolate controls that would reorder the text around them. */
export const DESKTOP_DICTATION_UNTYPED_CHARACTERS =
  /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

const languageTagSchema = v.pipe(
  v.string(),
  v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.localeLength),
  v.regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u),
);

export const desktopDictationCleanupRequestSchema = v.strictObject({
  /** The text the computer transcribed. Never the audio. */
  transcript: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.transcriptLength),
    v.regex(/^[\P{Cc}\n\t]*$/u),
  ),
  /** The desktop's language, a hint for the spoken commands to expect. */
  locale: v.optional(languageTagSchema),
  /** The languages the speaker dictates in; the text stays in them. */
  languages: v.optional(
    v.pipe(
      v.array(languageTagSchema),
      v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.languages),
    ),
  ),
});
export type DesktopDictationCleanupRequest = v.InferOutput<
  typeof desktopDictationCleanupRequestSchema
>;

/** Text the desktop types as is: no control characters, separators or
 *  bidirectional controls, so no keystroke other than the formatting
 *  segments below can come from it and the text reads in the order typed. */
const segmentTextSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.transcriptLength),
  v.check(
    (text) => !DESKTOP_DICTATION_UNTYPED_CHARACTERS.test(text),
    "Segment text holds a character the desktop does not type",
  ),
);

export const desktopDictationSegmentSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("text"),
    text: segmentTextSchema,
    bold: v.boolean(),
  }),
  v.strictObject({ type: v.literal("lineBreak") }),
  v.strictObject({ type: v.literal("paragraphBreak") }),
]);
export type DesktopDictationSegment = v.InferOutput<
  typeof desktopDictationSegmentSchema
>;

export const desktopDictationCleanupResponseSchema = v.strictObject({
  segments: v.pipe(
    v.array(desktopDictationSegmentSchema),
    v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.segments),
  ),
});
export type DesktopDictationCleanupResponse = v.InferOutput<
  typeof desktopDictationCleanupResponseSchema
>;
