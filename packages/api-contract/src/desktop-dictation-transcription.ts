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
/** The query parameter (set to `1`) a desktop that shows `provider` and
 *  `outsideRegion` sends with the models request. Without it the API lists
 *  only the region's models, without those fields, which older desktops
 *  refuse to read. */
export const DESKTOP_DICTATION_MODELS_LABELED_QUERY = "labels" as const;
/** The query parameter (set to `1`) a desktop that warns about
 *  `retainsData` sends with the models request. Without it the API lists no
 *  model whose provider keeps the audio, since an older desktop would offer
 *  it without the warning. */
export const DESKTOP_DICTATION_MODELS_RETENTION_QUERY = "retention" as const;
export const DESKTOP_DICTATION_TRANSCRIBE_PATH =
  `${STELLA_API_VERSION_PREFIX}/desktop/dictation/transcribe` as const;

/** Why stella AI cannot transcribe for this organization right now. */
export const DESKTOP_DICTATION_MODELS_UNAVAILABLE = [
  /** The organization's region offers no transcription model. */
  "region",
  /** No transcription model is eligible for the caller. The deployment has
   *  no transcription provider the caller can use, such as a self-hosted
   *  server without transcription credentials, or its only provider keeps
   *  audio and the caller did not request retaining models. */
  "provider",
] as const;

export const desktopDictationModelsSchema = v.strictObject({
  /** The models offered to the organization. Desktops ignore fields they
   *  do not know, so new optional fields can be added here. */
  models: v.array(
    v.strictObject({
      id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      /** Who runs the model, as a name to show, such as "Google". */
      provider: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
      /** The model processes audio outside the organization's region; the
       *  desktop says so where it is chosen. */
      outsideRegion: v.optional(v.boolean()),
      /** The provider keeps the audio and transcript under its own terms:
       *  the deployment's or organization's key has no zero data retention.
       *  The desktop warns where it is chosen. Never the default. */
      retainsData: v.optional(v.boolean()),
      /** The model reads vocabulary as spelling hints; the desktop sends
       *  the speaker's custom words with a chunk only for such a model, and
       *  only to an API that lists this field. */
      takesVocabulary: v.optional(v.boolean()),
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

/** Where a linked desktop files a recording's transcript in a matter. */
export const DESKTOP_DICTATION_TRANSCRIPTS_PATH =
  `${STELLA_API_VERSION_PREFIX}/desktop/dictation/transcripts` as const;

/** A recording is at most four hours, cut into pieces of at least fifteen
 *  seconds, so its transcript has at most this many paragraphs; a paragraph
 *  joins a few pieces of speech. */
export const DESKTOP_DICTATION_TRANSCRIPT_LIMITS = {
  titleLength: 200,
  paragraphs: 2000,
  paragraphLength: 10_000,
  /** Four hours of speech, with room for fast speakers. */
  totalLength: 1_000_000,
  /** Four hours, in milliseconds. */
  maxStartMs: 4 * 60 * 60 * 1000,
} as const;

/** A transcript's paragraphs, each with where it starts in the recording. */
export const desktopDictationTranscriptParagraphsSchema = v.pipe(
  v.array(
    v.strictObject({
      startMs: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(0),
        v.maxValue(DESKTOP_DICTATION_TRANSCRIPT_LIMITS.maxStartMs),
      ),
      text: v.pipe(
        v.string(),
        v.maxLength(DESKTOP_DICTATION_TRANSCRIPT_LIMITS.paragraphLength),
      ),
    }),
  ),
  v.minLength(1),
  v.maxLength(DESKTOP_DICTATION_TRANSCRIPT_LIMITS.paragraphs),
  v.check(
    (paragraphs) =>
      paragraphs.reduce((total, { text }) => total + text.length, 0) <=
      DESKTOP_DICTATION_TRANSCRIPT_LIMITS.totalLength,
    "The transcript is longer than a recording of four hours",
  ),
);

/** What a filed transcript is called in the matter. */
export const desktopDictationTranscriptSavedSchema = v.strictObject({
  fileName: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});
export type DesktopDictationTranscriptSaved = v.InferOutput<
  typeof desktopDictationTranscriptSavedSchema
>;
