import { Result } from "better-result";
import * as v from "valibot";

import {
  countDictationCodePoints,
  DESKTOP_DICTATION_CLEANUP_LIMITS,
  desktopDictationCleanupResponseSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";
import type { DesktopDictationCleanupResponse } from "@stll/api-contract/desktop-dictation-cleanup";
import { desktopDictationModelsSchema } from "@stll/api-contract/desktop-dictation-transcription";
import type { DesktopDictationModels } from "@stll/api-contract/desktop-dictation-transcription";
import {
  MAX_TRANSCRIPTION_AUDIO_SECONDS,
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERMS,
  TRANSCRIPTION_LABELS_SHOWN_FIELD,
} from "@stll/api-contract/transcription";
import type { TRANSCRIPTION_AUDIO_MEDIA_TYPES } from "@stll/api-contract/transcription";
import { foldSearchMatchText } from "@stll/text-normalize";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { partOfType } from "@/state/form-part";
import type { FormPart } from "@/state/form-part";

/** The longest recording one transcription takes; recording stops there. */
export const DICTATION_MAX_SECONDS = MAX_TRANSCRIPTION_AUDIO_SECONDS;

/**
 * The server waits up to a minute for the transcription provider; the phone
 * waits a little longer, so the server's own answer arrives first.
 */
const TRANSCRIBE_TIMEOUT_MS = 75_000;

const transcriptionSchema = v.object({ text: v.string() });

/** What the recorder writes on iOS and Android: AAC in an MP4 container. */
const RECORDING_TYPE: (typeof TRANSCRIPTION_AUDIO_MEDIA_TYPES)[number] =
  "audio/mp4";

/** What one dictation is transcribed with, beyond the recording. */
export type TranscriptionChoice = {
  /**
   * The model the person picked from `readDictationModels`, whose labels
   * they saw there; absent, the server uses the one its region offers.
   */
  readonly modelId?: string | undefined;
  /** The matter the text is for, whose names the model should expect. */
  readonly matterId?: string | undefined;
  readonly vocabulary?: readonly string[] | undefined;
};

/**
 * Turns one recording into text through the server's transcription, which
 * keeps neither the audio nor the text. Without a chosen model the server
 * uses the one its region offers. A chosen model goes with the mark that
 * the person saw where it runs and whether its provider keeps the audio,
 * which the server needs before it serves such a model. The recording is an
 * AAC file in an MP4 container, what the recorder writes on iOS and Android.
 */
export const transcribeRecording = async ({
  fetch,
  source,
  audio,
  choice = {},
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  /** The recording: on the phone, Expo's `File`. */
  readonly audio: FormPart;
  readonly choice?: TranscriptionChoice;
}): Promise<Result<string, ApiError>> => {
  const form = new FormData();
  form.append("file", partOfType(audio, RECORDING_TYPE));
  if (choice.modelId !== undefined) {
    form.append("modelId", choice.modelId);
    form.append(TRANSCRIPTION_LABELS_SHOWN_FIELD, "1");
  }
  if (choice.matterId !== undefined) {
    form.append("matterId", choice.matterId);
  }
  if (choice.vocabulary !== undefined && choice.vocabulary.length > 0) {
    form.append("vocabulary", JSON.stringify(choice.vocabulary));
  }
  const transcribed = await requestApi({
    fetch,
    source,
    path: "/v1/dictation/transcribe",
    body: form,
    schema: transcriptionSchema,
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
  });
  return transcribed.map(({ text }) => text.trim());
};

/**
 * The models the person may transcribe with, each with where it runs and
 * whether its provider keeps the audio, and the one used when none is
 * chosen.
 */
export const readDictationModels = async ({
  fetch,
  source,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<DesktopDictationModels, ApiError>> =>
  await requestApi({
    fetch,
    source,
    path: "/v1/dictation/models",
    schema: desktopDictationModelsSchema,
  });

const vocabularySchema = v.object({
  candidates: v.array(v.object({ term: v.string(), weight: v.number() })),
});

/**
 * The names and references of a matter the transcription should expect,
 * the weightiest first, as many as one transcription takes.
 */
export const readMatterVocabulary = async ({
  fetch,
  source,
  matterId,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly matterId: string;
}): Promise<Result<string[], ApiError>> => {
  const read = await requestApi({
    fetch,
    source,
    path: `/v1/workspaces/${encodeURIComponent(matterId)}/vocabulary`,
    schema: vocabularySchema,
  });
  return read.map(({ candidates }) =>
    vocabularyTerms(candidates.map(({ term, weight }) => ({ term, weight }))),
  );
};

/** The terms one transcription takes: distinct, short enough, weightiest first. */
export const vocabularyTerms = (
  candidates: readonly { term: string; weight: number }[],
): string[] =>
  [
    ...new Set(
      // A new array, sorted in place: the phone's engine has no `toSorted`.
      candidates
        .filter(
          ({ term }) =>
            term.trim() !== "" &&
            term.length <= MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
        )
        .sort((a, b) => b.weight - a.weight)
        .map(({ term }) => term.trim()),
    ),
  ].slice(0, MAX_TRANSCRIPTION_VOCABULARY_TERMS);

/** The phone gives up on cleanup sooner than on transcription: the raw text is there. */
const CLEANUP_TIMEOUT_MS = 10_000;

/**
 * Has stella AI fix recognition mistakes and turn spoken punctuation and
 * line breaks into typed ones, for a chat message. Only the text goes, never
 * the audio, and nothing is kept. A transcript longer than cleanup takes is
 * returned as it is.
 */
export const cleanUpDictation = async ({
  fetch,
  source,
  transcript,
  locale,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly transcript: string;
  /** The app's language, which names the spoken commands to expect. */
  readonly locale: string;
}): Promise<Result<string, ApiError>> => {
  if (
    countDictationCodePoints(transcript) >
    DESKTOP_DICTATION_CLEANUP_LIMITS.transcriptLength
  ) {
    return Result.ok(transcript);
  }
  const cleaned = await requestApi({
    fetch,
    source,
    path: "/v1/dictation/cleanup",
    body: { transcript, locale, context: { appKind: "chat" } },
    schema: desktopDictationCleanupResponseSchema,
    timeoutMs: CLEANUP_TIMEOUT_MS,
  });
  return cleaned.map(({ segments }) => segmentsText(segments).trim());
};

/** Cleanup's typed segments as plain text: breaks as new lines, bold as text. */
export const segmentsText = (
  segments: DesktopDictationCleanupResponse["segments"],
): string => segments.map(segmentText).join("");

const segmentText = (
  segment: DesktopDictationCleanupResponse["segments"][number],
): string => {
  if (segment.type === "text") {
    return segment.text;
  }
  return segment.type === "lineBreak" ? "\n" : "\n\n";
};

/** Where the cursor is in a text field, in UTF-16 units as React Native reports it. */
export type TextSelection = { readonly start: number; readonly end: number };

/** A dictation's text and the names it was transcribed with. */
export type Dictated = {
  readonly text: string;
  /** The matter's names: a first word that is one of them keeps its capital. */
  readonly names: readonly string[];
};

type InsertDictationOptions = {
  readonly draft: string;
  /** Unknown, the text goes at the end. */
  readonly selection: TextSelection | undefined;
  readonly dictated: Dictated;
  /** The app's language: in German, nouns keep their capital mid-sentence. */
  readonly locale: string;
};

/**
 * Puts dictated text where the cursor is, in place of any selection, joined
 * as if typed there: a space on either side where a word meets a word, none
 * before a comma or after an opening bracket. Mid-sentence the first word
 * loses the capital the model gives every transcript, unless it is a name
 * or written in capitals, and a full stop before the sentence goes on is
 * dropped; at the start of a sentence the first letter is a capital. Also
 * where the dictated text starts, and where the cursor ends up: after it.
 */
export const insertDictation = ({
  draft,
  selection,
  dictated,
  locale,
}: InsertDictationOptions): { text: string; start: number; caret: number } => {
  const start = clampOffset(selection?.start ?? draft.length, draft);
  const end = Math.max(start, clampOffset(selection?.end ?? start, draft));
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  let text = dictated.text.trim();
  if (text === "") {
    return { text: draft, start: end, caret: end };
  }
  if (startsSentence(before)) {
    text = capitalizeFirst(text);
  } else if (!locale.toLowerCase().startsWith("de")) {
    text = lowercaseFirstWord(text, dictated.names);
  }
  // The sentence goes on after the cursor, on the same line, in lower case
  // or after a comma.
  const next = after.replace(/^[^\S\n]+/u, "").at(0);
  if (
    next !== undefined &&
    /^[\p{Ll}.,;:!?]/u.test(next) &&
    text.endsWith(".") &&
    !text.endsWith("..")
  ) {
    text = text.slice(0, -1);
  }
  const lead = needsSpaceBefore(before, text) ? " " : "";
  const trail = needsSpaceAfter(text, after) ? " " : "";
  const at = before.length + lead.length;
  return {
    text: `${before}${lead}${text}${trail}${after}`,
    start: at,
    caret: at + text.length,
  };
};

const clampOffset = (offset: number, text: string): number =>
  Math.min(Math.max(0, Math.trunc(offset)), text.length);

/** Quotes and brackets that close what precedes the cursor. */
const CLOSING = new Set([")", "]", "}", "»", "”", "“", "’", "'", '"']);
const OPENING = new Set(["(", "[", "{", "«", "„", "‚", "¿", "¡", "/"]);
/** Quotes that open or close depending on what stands before them. */
const EITHER_QUOTE = new Set(['"', "'", "“", "‘"]);

/** Whether text typed after `before` starts a sentence: at the start, after a line break or a sentence's end. */
const startsSentence = (before: string): boolean => {
  if (/\n[^\S\n]*$/u.test(before)) {
    return true;
  }
  let index = before.trimEnd().length;
  while (index > 0 && CLOSING.has(before.charAt(index - 1))) {
    index -= 1;
  }
  return index === 0 || /[.!?…]/u.test(before.charAt(index - 1));
};

const needsSpaceBefore = (before: string, text: string): boolean => {
  const last = before.at(-1);
  if (
    last === undefined ||
    /\s/u.test(last) ||
    /^[.,;:!?…)\]}»%]/u.test(text)
  ) {
    return false;
  }
  if (OPENING.has(last)) {
    return false;
  }
  // A quote right after a space or at the start opens a quotation.
  if (EITHER_QUOTE.has(last)) {
    const prior = before.at(-2);
    return prior !== undefined && !/\s/u.test(prior);
  }
  return true;
};

const needsSpaceAfter = (text: string, after: string): boolean => {
  const next = after.at(0);
  return (
    next !== undefined &&
    !/\s/u.test(next) &&
    !/^[.,;:!?…)\]}»%]/u.test(next) &&
    !CLOSING.has(next) &&
    !/\s$/u.test(text)
  );
};

const capitalizeFirst = (text: string): string => {
  const first = /^\P{L}*(\p{L}+)/u.exec(text)?.at(1) ?? "";
  // A word with a capital inside, as "iPhone", is written that way.
  if (first === "" || first !== first.toLowerCase()) {
    return text;
  }
  const at = text.indexOf(first);
  return `${text.slice(0, at)}${first.charAt(0).toUpperCase()}${text.slice(at + 1)}`;
};

/**
 * The first word in lower case when only its first letter is a capital and
 * it is no name; "I" and its contractions stay.
 */
const lowercaseFirstWord = (text: string, names: readonly string[]): string => {
  const first = /^\P{L}*(\p{L}[\p{L}\p{M}'’-]*)/u.exec(text)?.at(1) ?? "";
  const rest = first.slice(1);
  if (
    first === "" ||
    !startsUpper(first) ||
    rest !== rest.toLowerCase() ||
    /^I(?:['’]|$)/u.test(first) ||
    isName(first, names)
  ) {
    return text;
  }
  const at = text.indexOf(first);
  return `${text.slice(0, at)}${first.charAt(0).toLowerCase()}${text.slice(at + 1)}`;
};

/** Whether a word is one of the names, or a name with a case ending, as "Nováka" of "Novák". */
const isName = (word: string, names: readonly string[]): boolean => {
  const folded = foldSearchMatchText(word);
  return names.some((name) => {
    const head = foldSearchMatchText(name.split(/\s/u).at(0) ?? "");
    return head !== "" && folded.startsWith(head) && startsUpper(name);
  });
};

const startsUpper = (word: string): boolean => /^\p{Lu}/u.test(word);
