import * as v from "valibot";

import {
  DESKTOP_DICTATION_CLEANUP_LIMITS,
  DESKTOP_DICTATION_UNTYPED_CHARACTERS,
} from "./desktop-dictation-cleanup";
import { UPLOAD_DOCUMENT_MAX_BYTES } from "./document-version-upload";
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

/** Where a desktop finalizes the recording it uploaded into a transcript's
 *  folder, once its bytes are at the presigned URL. */
export const DESKTOP_DICTATION_TRANSCRIPT_AUDIO_PATH =
  `${DESKTOP_DICTATION_TRANSCRIPTS_PATH}/audio` as const;

/** The largest recording a transcript's folder takes: the largest document a
 *  matter stores. A larger one is left out and the Word documents are still
 *  filed. */
export const MAX_DESKTOP_DICTATION_TRANSCRIPT_AUDIO_BYTES =
  UPLOAD_DOCUMENT_MAX_BYTES;

/** Bounds of what a desktop sends to file a transcript as a folder. */
export const DESKTOP_DICTATION_TRANSCRIPT_FOLDER_LIMITS = {
  /** A document name the desktop composes from the title, without its
   *  extension. */
  documentNameLength: 220,
  /** The label above the dictation's instructions. */
  labelLength: 100,
  /** The cleaned-up text, as Markdown: the transcript's own bound, with
   *  room for the formatting. */
  markdownLength: 1_200_000,
  /** Instructions the speaker gave in the dictation. */
  instructions: 200,
  instructionLength: 2000,
  /** The recording's file name, as the matter shows it. */
  audioNameLength: 255,
  /** A recording no file system holds more of; the matter's own limit is
   *  checked against it and answered, not refused. */
  audioDeclaredBytes: 64 * 1024 * 1024 * 1024,
} as const;

const boundedText = (maxLength: number) =>
  v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maxLength));

/** How the desktop names what it files, in the member's language: the
 *  transcript, the cleaned-up text and the label above the instructions. */
export const desktopDictationTranscriptFolderSchema = v.strictObject({
  transcriptName: boundedText(
    DESKTOP_DICTATION_TRANSCRIPT_FOLDER_LIMITS.documentNameLength,
  ),
  cleanedName: boundedText(
    DESKTOP_DICTATION_TRANSCRIPT_FOLDER_LIMITS.documentNameLength,
  ),
  instructionsLabel: boundedText(
    DESKTOP_DICTATION_TRANSCRIPT_FOLDER_LIMITS.labelLength,
  ),
});

/** The cleaned-up text, and the instructions the speaker gave in it. */
export const desktopDictationTranscriptCleanedSchema = v.strictObject({
  markdown: boundedText(
    DESKTOP_DICTATION_TRANSCRIPT_FOLDER_LIMITS.markdownLength,
  ),
  instructions: v.pipe(
    v.array(
      boundedText(DESKTOP_DICTATION_TRANSCRIPT_FOLDER_LIMITS.instructionLength),
    ),
    v.maxLength(DESKTOP_DICTATION_TRANSCRIPT_FOLDER_LIMITS.instructions),
  ),
});

/** The recording the desktop is about to upload into the folder. */
export const desktopDictationTranscriptAudioSchema = v.strictObject({
  name: boundedText(DESKTOP_DICTATION_TRANSCRIPT_FOLDER_LIMITS.audioNameLength),
  mimeType: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  size: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(DESKTOP_DICTATION_TRANSCRIPT_FOLDER_LIMITS.audioDeclaredBytes),
  ),
  sha256Hex: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
});

const savedFileNameSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
);

/** What happens to the recording a desktop declared. */
export const desktopDictationTranscriptAudioOutcomeSchema = v.variant(
  "status",
  [
    /** PUT the bytes to `url` with `headers`, then finalize `uploadId`. */
    v.strictObject({
      status: v.literal("upload"),
      uploadId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
      url: v.pipe(v.string(), v.minLength(1), v.maxLength(16_384)),
      expiresAt: v.pipe(v.string(), v.maxLength(64)),
      headers: v.record(
        v.pipe(v.string(), v.maxLength(256)),
        v.pipe(v.string(), v.maxLength(4096)),
      ),
    }),
    /** Larger than a matter document may be; it was left out. */
    v.strictObject({
      status: v.literal("too_large"),
      maxBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
    /** The matter does not take it, such as at its document limit. */
    v.strictObject({
      status: v.literal("refused"),
      message: v.pipe(v.string(), v.maxLength(512)),
    }),
  ],
);
export type DesktopDictationTranscriptAudioOutcome = v.InferOutput<
  typeof desktopDictationTranscriptAudioOutcomeSchema
>;

/** What a filed transcript is called in the matter. A desktop that sent
 *  `folder` also reads the folder, every document filed in it, any left
 *  out, and what happens to the recording it declared; an older one reads
 *  `fileName`. */
export const desktopDictationTranscriptSavedSchema = v.strictObject({
  fileName: savedFileNameSchema,
  folderName: v.optional(savedFileNameSchema),
  files: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          kind: v.picklist(["transcript", "cleaned"]),
          fileName: savedFileNameSchema,
        }),
      ),
      v.maxLength(2),
    ),
  ),
  /** A document that could not be filed once the transcript was: the save
   *  still succeeded, and the folder holds what `files` lists. */
  notFiled: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          kind: v.picklist(["cleaned"]),
          message: v.pipe(v.string(), v.maxLength(512)),
        }),
      ),
      v.maxLength(1),
    ),
  ),
  audio: v.optional(desktopDictationTranscriptAudioOutcomeSchema),
});
export type DesktopDictationTranscriptSaved = v.InferOutput<
  typeof desktopDictationTranscriptSavedSchema
>;

/** What the finalized recording is called in the folder. */
export const desktopDictationTranscriptAudioSavedSchema = v.strictObject({
  fileName: savedFileNameSchema,
});
export type DesktopDictationTranscriptAudioSaved = v.InferOutput<
  typeof desktopDictationTranscriptAudioSavedSchema
>;
