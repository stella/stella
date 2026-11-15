import * as v from "valibot";

import {
  DESKTOP_DICTATION_CLEANUP_LIMITS,
  DESKTOP_DICTATION_UNTYPED_CHARACTERS,
} from "./desktop-dictation-cleanup";
import { STELLA_API_VERSION_PREFIX } from "./index";

// desktop-dictation-transcription.json is the native client's contract:
// transcription.ts reads its audio limits from it, and
// desktop-dictation-transcription.test.ts binds these paths to it.
export const DESKTOP_DICTATION_MODELS_PATH =
  `${STELLA_API_VERSION_PREFIX}/desktop/dictation/models` as const;
export const DESKTOP_DICTATION_TRANSCRIBE_PATH =
  `${STELLA_API_VERSION_PREFIX}/desktop/dictation/transcribe` as const;

/** Why stella AI cannot transcribe for this organization right now. */
export const DESKTOP_DICTATION_MODELS_UNAVAILABLE = [
  /** The organization's region offers no transcription model. */
  "region",
  /** The organization's own AI provider does not transcribe. */
  "provider",
] as const;

export const desktopDictationModelsSchema = v.strictObject({
  /** Only the models offered in the organization's region. */
  models: v.array(
    v.strictObject({
      id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
  ),
  /** The model a request without one gets; null when none is offered. */
  defaultModelId: v.nullable(v.pipe(v.string(), v.maxLength(128))),
  unavailable: v.nullable(v.picklist(DESKTOP_DICTATION_MODELS_UNAVAILABLE)),
});
export type DesktopDictationModels = v.InferOutput<
  typeof desktopDictationModelsSchema
>;

/** The longest transcript one audio chunk is answered with: what cleanup
 *  accepts, so the text stella AI transcribed can always be cleaned up. */
export const MAX_DESKTOP_DICTATION_TRANSCRIPT_LENGTH =
  DESKTOP_DICTATION_CLEANUP_LIMITS.transcriptLength;

/** The transcript as the desktop types it: no control characters,
 *  separators or bidirectional controls. */
export const desktopDictationTranscriptSchema = v.strictObject({
  text: v.pipe(
    v.string(),
    v.maxLength(MAX_DESKTOP_DICTATION_TRANSCRIPT_LENGTH),
    v.check(
      (text) => !DESKTOP_DICTATION_UNTYPED_CHARACTERS.test(text),
      "Transcript holds a character the desktop does not type",
    ),
  ),
});
