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

/** Text the desktop types as is: no control characters, so no keystroke
 *  other than the formatting segments below can come from it. */
const segmentTextSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.transcriptLength),
  v.regex(/^\P{Cc}+$/u),
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
