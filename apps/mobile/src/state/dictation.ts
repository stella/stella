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

/**
 * Puts dictated text after what is already in the box, with one space
 * between them, so dictating twice reads as one message.
 */
export const appendDictation = (draft: string, dictated: string): string => {
  if (dictated === "") {
    return draft;
  }
  if (draft === "" || /\s$/u.test(draft)) {
    return `${draft}${dictated}`;
  }
  return `${draft} ${dictated}`;
};
