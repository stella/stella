import * as v from "valibot";

import contract from "./desktop-dictation-cleanup.json";
import { STELLA_API_VERSION_PREFIX } from "./index";
import {
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERMS,
} from "./transcription";

// desktop-dictation-cleanup.json carries the same values for the native
// client; desktop-dictation-cleanup.test.ts binds the two.
export const DESKTOP_DICTATION_CLEANUP_PATH =
  `${STELLA_API_VERSION_PREFIX}/desktop/dictation/cleanup` as const;

export const DESKTOP_DICTATION_CLEANUP_LIMITS = {
  transcriptLength: contract.maxTranscriptLength,
  localeLength: contract.maxLocaleLength,
  languages: contract.maxLanguages,
  segments: contract.maxSegments,
  windowTitleLength: contract.maxWindowTitleLength,
  textBeforeCursorLength: contract.maxTextBeforeCursorLength,
  customInstructionsLength: contract.maxCustomInstructionsLength,
  modelLength: contract.maxModelLength,
  models: contract.maxModels,
  modelDisplayNameLength: contract.maxModelDisplayNameLength,
} as const;

/** The models a linked desktop may choose for cleanup besides automatic:
 *  the ones the organization's chat model picker offers. */
export const DESKTOP_DICTATION_CLEANUP_MODELS_PATH =
  `${STELLA_API_VERSION_PREFIX}/desktop/dictation/cleanup-models` as const;

/** The kind of app a dictation goes to, which sets the register cleanup
 *  writes in. Webmail and online documents cannot be told apart from other
 *  pages, so they are `browser`. `appKinds` in the JSON file lists the same
 *  values for the native client. */
export const DESKTOP_DICTATION_APP_KINDS = [
  "email",
  "chat",
  "document",
  "browser",
  "code",
  "terminal",
  "other",
] as const;
export type DesktopDictationAppKind =
  (typeof DESKTOP_DICTATION_APP_KINDS)[number];

/** How cleanup writes a dictation: `polished` fixes recognition mistakes
 *  and keeps the wording (the form when a request names none), `casual`
 *  keeps a relaxed tone, `notes` writes terse points, and `verbatim`
 *  changes no word, only casing, punctuation and spoken commands. `styles`
 *  in the JSON file lists the same values. */
export const DESKTOP_DICTATION_CLEANUP_STYLES = [
  "polished",
  "casual",
  "notes",
  "verbatim",
] as const;
export type DesktopDictationCleanupStyle =
  (typeof DESKTOP_DICTATION_CLEANUP_STYLES)[number];
export const DESKTOP_DICTATION_DEFAULT_CLEANUP_STYLE =
  "polished" satisfies DesktopDictationCleanupStyle;

/** The languages cleanup can write a dictation in when asked to translate
 *  it: the languages the apps come in. `translationLanguages` in the JSON
 *  file lists the same values. */
export const DESKTOP_DICTATION_TRANSLATION_LANGUAGES = [
  "ar",
  "cs",
  "de",
  "en",
  "es",
  "et",
  "fr",
  "hu",
  "lt",
  "lv",
  "pl",
  "pt-BR",
  "sk",
] as const;
export type DesktopDictationTranslationLanguage =
  (typeof DESKTOP_DICTATION_TRANSLATION_LANGUAGES)[number];

/** Code points, the way the desktop counts them (Rust `chars().count()`),
 *  so both sides hold a text to the same bound. */
export const countDictationCodePoints = (text: string): number => {
  let count = 0;
  for (const _codePoint of text) {
    count += 1;
  }
  return count;
};

const maxCodePoints = (limit: number) =>
  v.check(
    (text: string) => countDictationCodePoints(text) <= limit,
    `Text is longer than ${limit} characters`,
  );

/** A code-point bound, with the UTF-16 bound it implies (two units per code
 *  point at most) stated too, so the published schema carries a length. */
const boundedText = (limit: number) =>
  v.pipe(v.string(), v.maxLength(limit * 2), maxCodePoints(limit));

/** What the speaker wrote for cleanup to follow, such as "use British
 *  spelling, never use emoji": style guidance below the system rules, which
 *  never replaces them or the answer's shape. Several lines may come;
 *  no other control character. Neither logged nor stored. */
const customInstructionsSchema = v.optional(
  v.pipe(
    boundedText(DESKTOP_DICTATION_CLEANUP_LIMITS.customInstructionsLength),
    v.minLength(1),
    v.regex(/^[\P{Cc}\n\t]*$/u),
  ),
);

/** A model as the chat model picker names it (`provider::modelId`). */
const cleanupModelSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.modelLength),
  v.regex(/^\P{Cc}+$/u),
);

/** How far a cleaned answer may shrink from what was dictated. Cleanup
 *  replaces spoken `formattingCommands` by marks, breaks or bold, so the
 *  transcript is measured by its letters and digits outside complete
 *  commands. A self-correction drops its `correctionMarkers` phrase and the
 *  alternative it discards: within one sentence (up to a `sentenceEndMarks`
 *  character or a command), a marker with dictated words on both sides may
 *  drop itself and as much of the words before it as the correction after
 *  it holds. An answer that keeps less than `minAnswerTextPercent` of the
 *  rest (`condensedMinAnswerTextPercent` for notes or a translation, which
 *  word the dictation anew), or breaks a line far more often than the
 *  dictation could have asked for, lost content and is replaced by the raw
 *  transcript. Only a dictation of formatting commands alone may be answered
 *  by breaks alone. */
export const DESKTOP_DICTATION_CLEANUP_PLAUSIBILITY = {
  minAnswerTextPercent: contract.minAnswerTextPercent,
  condensedMinAnswerTextPercent: contract.condensedMinAnswerTextPercent,
  minBreakAllowance: contract.minBreakAllowance,
  transcriptCharactersPerBreak: contract.transcriptCharactersPerBreak,
  sentenceEndMarks: contract.sentenceEndMarks,
  formattingCommands: contract.formattingCommands,
  correctionMarkers: contract.correctionMarkers,
} as const;

/** The share of the dictated letters and digits a cleaned answer must
 *  keep, by how it was asked to write them. */
export const dictationCleanupMinAnswerTextPercent = ({
  style,
  translateTo,
}: Pick<DesktopDictationCleanupRequest, "style" | "translateTo">): number =>
  style === "notes" || translateTo !== undefined
    ? DESKTOP_DICTATION_CLEANUP_PLAUSIBILITY.condensedMinAnswerTextPercent
    : DESKTOP_DICTATION_CLEANUP_PLAUSIBILITY.minAnswerTextPercent;

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

/** What cleanup may know about where the text goes. The kind of app comes
 *  with every cleanup; the window title and the text before the cursor only
 *  when the speaker turned each on. */
export const desktopDictationCleanupContextSchema = v.strictObject({
  appKind: v.picklist(DESKTOP_DICTATION_APP_KINDS),
  /** The focused window's title, which can name a client or a matter. */
  windowTitle: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      maxCodePoints(DESKTOP_DICTATION_CLEANUP_LIMITS.windowTitleLength),
      v.regex(/^\P{Cc}*$/u),
    ),
  ),
  /** The end of the text right before the cursor: part of the document the
   *  speaker is in. */
  textBeforeCursor: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      maxCodePoints(DESKTOP_DICTATION_CLEANUP_LIMITS.textBeforeCursorLength),
      v.regex(/^[\P{Cc}\n\t]*$/u),
    ),
  ),
});
export type DesktopDictationCleanupContext = v.InferOutput<
  typeof desktopDictationCleanupContextSchema
>;

/** The desktop's language, a hint for the spoken commands to expect. */
const localeSchema = v.optional(languageTagSchema);

/** The languages the speaker dictates in; the text stays in them. */
const languagesSchema = v.optional(
  v.pipe(
    v.array(languageTagSchema),
    v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.languages),
  ),
);

/** The speaker's custom words: how they spell names and terms they
 *  dictate, within the transcription vocabulary's limits. Data for the
 *  model, never instructions and never added to the answer; neither
 *  logged nor stored. */
const vocabularySchema = v.optional(
  v.pipe(
    v.array(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH),
        v.regex(/^\P{Cc}*$/u),
      ),
    ),
    v.maxLength(MAX_TRANSCRIPTION_VOCABULARY_TERMS),
  ),
);

export const desktopDictationCleanupRequestSchema = v.strictObject({
  /** The text the computer transcribed. Never the audio. */
  transcript: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.transcriptLength),
    v.regex(/^[\P{Cc}\n\t]*$/u),
  ),
  locale: localeSchema,
  languages: languagesSchema,
  /** Where the text goes, so cleanup writes in that app's register. Data
   *  for the model, never instructions and never part of the answer; it is
   *  neither logged nor stored. */
  context: v.optional(desktopDictationCleanupContextSchema),
  vocabulary: vocabularySchema,
  /** How to write the text; `polished` when absent. */
  style: v.optional(v.picklist(DESKTOP_DICTATION_CLEANUP_STYLES)),
  /** The language to write the cleaned text in, whatever language it was
   *  dictated in. Absent, every word stays in its spoken language. */
  translateTo: v.optional(v.picklist(DESKTOP_DICTATION_TRANSLATION_LANGUAGES)),
  customInstructions: customInstructionsSchema,
  /** The model the speaker chose from `DESKTOP_DICTATION_CLEANUP_MODELS_PATH`;
   *  absent: automatic, the organization's fast model. One the organization
   *  no longer offers is cleaned up automatically, never refused. */
  model: v.optional(cleanupModelSchema),
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

/** One model cleanup may run on: its picker value, its name and the
 *  provider that runs it. */
export const desktopDictationCleanupModelSchema = v.strictObject({
  value: cleanupModelSchema,
  displayName: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.modelDisplayNameLength),
  ),
  provider: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.modelDisplayNameLength),
  ),
});

/** The models besides automatic, in the chat model picker's order. */
export const desktopDictationCleanupModelsSchema = v.strictObject({
  models: v.pipe(
    v.array(desktopDictationCleanupModelSchema),
    v.maxLength(DESKTOP_DICTATION_CLEANUP_LIMITS.models),
  ),
});
export type DesktopDictationCleanupModels = v.InferOutput<
  typeof desktopDictationCleanupModelsSchema
>;

// --- Recording cleanup ------------------------------------------------------

const recordingContract = contract.recordingCleanup;

/** Cleans one part of a recording's transcript into formatted text, for the
 *  desktop's "Transcribe a recording" window. */
export const DESKTOP_DICTATION_RECORDING_CLEANUP_PATH =
  `${STELLA_API_VERSION_PREFIX}/desktop/dictation/recording-cleanup` as const;

/** The same cleanup for a signed-in member's session (web and phone apps),
 *  with the same request and answer. */
export const DICTATION_RECORDING_CLEANUP_PATH =
  `${STELLA_API_VERSION_PREFIX}/dictation/recording-cleanup` as const;

/** Lengths in code points, the way the desktop counts them. A recording is
 *  cleaned part by part: the desktop splits the transcript into parts of at
 *  most `transcriptLength` and sends the end of the text cleaned so far as
 *  `previousText`. */
export const DESKTOP_DICTATION_RECORDING_CLEANUP_LIMITS = {
  transcriptLength: recordingContract.maxTranscriptLength,
  previousTextLength: recordingContract.maxPreviousTextLength,
  instructions: recordingContract.maxInstructions,
  instructionLength: recordingContract.maxInstructionLength,
  markdownLength: recordingContract.maxMarkdownLength,
} as const;

const recordingTextSchema = (limit: number) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    maxCodePoints(limit),
    v.regex(/^[\P{Cc}\n\t]*$/u),
  );

export const desktopDictationRecordingCleanupRequestSchema = v.strictObject({
  /** One part of the text the computer transcribed from a recording. Never
   *  the audio. */
  transcript: recordingTextSchema(
    DESKTOP_DICTATION_RECORDING_CLEANUP_LIMITS.transcriptLength,
  ),
  /** The end of the cleaned text before this part, so the part continues a
   *  sentence or list instead of repeating it. Data for the model, never
   *  instructions and never part of the answer. */
  previousText: v.optional(
    recordingTextSchema(
      DESKTOP_DICTATION_RECORDING_CLEANUP_LIMITS.previousTextLength,
    ),
  ),
  locale: localeSchema,
  languages: languagesSchema,
  vocabulary: vocabularySchema,
  customInstructions: customInstructionsSchema,
});
export type DesktopDictationRecordingCleanupRequest = v.InferOutput<
  typeof desktopDictationRecordingCleanupRequestSchema
>;

/** Characters a recording cleanup answer never holds: every control except
 *  the line feed, the Unicode line and paragraph separators, and the
 *  bidirectional controls. */
export const DESKTOP_DICTATION_RECORDING_UNWRITTEN_CHARACTERS =
  /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

const writtenText = (allowLineFeed: boolean) =>
  v.check(
    (text: string) =>
      !DESKTOP_DICTATION_RECORDING_UNWRITTEN_CHARACTERS.test(
        allowLineFeed ? text.replaceAll("\n", "") : text,
      ),
    "Text holds a character a cleaned recording never carries",
  );

/**
 * The cleaned part of a recording.
 *
 * `instructions` are what the speaker said to whoever types the text (who it
 * is for, copies, where it goes, how to format it), one sentence each, never
 * part of the text.
 *
 * `markdown` is the text itself in a Markdown subset: paragraphs separated by
 * a blank line, `#`, `##` and `###` headings, `**bold**`, `*italic*`, `- `
 * bullets and `1. ` numbered lists nested at most one level. No links,
 * images, HTML, code, tables, block quotes or rules; the server removes
 * them. Lines end in `\n` only.
 */
export const desktopDictationRecordingCleanupResponseSchema = v.strictObject({
  instructions: v.pipe(
    v.array(
      v.pipe(
        boundedText(
          DESKTOP_DICTATION_RECORDING_CLEANUP_LIMITS.instructionLength,
        ),
        v.minLength(1),
        writtenText(false),
      ),
    ),
    v.maxLength(DESKTOP_DICTATION_RECORDING_CLEANUP_LIMITS.instructions),
  ),
  markdown: v.pipe(
    boundedText(DESKTOP_DICTATION_RECORDING_CLEANUP_LIMITS.markdownLength),
    writtenText(true),
  ),
});
export type DesktopDictationRecordingCleanupResponse = v.InferOutput<
  typeof desktopDictationRecordingCleanupResponseSchema
>;
