import type { Result } from "better-result";
import * as v from "valibot";

import { MAX_TRANSCRIPTION_AUDIO_SECONDS } from "@stll/api-contract/transcription";
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

/**
 * Turns one recording into text through the server's transcription, which
 * keeps neither the audio nor the text. No model is named, so the server
 * uses the one its region offers. The recording is an AAC file in an MP4
 * container, what the recorder writes on iOS and Android.
 */
export const transcribeRecording = async ({
  fetch,
  source,
  audio,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  /** The recording: on the phone, Expo's `File`. */
  readonly audio: FormPart;
}): Promise<Result<string, ApiError>> => {
  const form = new FormData();
  form.append("file", partOfType(audio, RECORDING_TYPE));
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
