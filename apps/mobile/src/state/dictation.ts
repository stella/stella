import type { Result } from "better-result";
import * as v from "valibot";

import { MAX_TRANSCRIPTION_AUDIO_SECONDS } from "@stll/api-contract/transcription";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** The longest recording one transcription takes; recording stops there. */
export const DICTATION_MAX_SECONDS = MAX_TRANSCRIPTION_AUDIO_SECONDS;

/**
 * The server waits up to a minute for the transcription provider; the phone
 * waits a little longer, so the server's own answer arrives first.
 */
const TRANSCRIBE_TIMEOUT_MS = 75_000;

const transcriptionSchema = v.object({ text: v.string() });

/** A recorded file on the phone, as React Native's multipart upload names one. */
type RecordedFile = {
  readonly uri: string;
  readonly name: string;
  readonly type: string;
};

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- only an interface merges into the global FormData
  interface FormData {
    /**
     * React Native's `FormData` also takes a file by its location and
     * streams it from disk; the DOM typings know only `Blob`s.
     */
    // oxlint-disable-next-line typescript/method-signature-style -- a method adds an overload; a property would replace the DOM's
    append(name: string, value: RecordedFile): void;
  }
}

/**
 * Turns one recording into text through the server's transcription, which
 * keeps neither the audio nor the text. No model is named, so the server
 * uses the one its region offers. The recording is an AAC file in an MP4
 * container, what the recorder writes on iOS and Android.
 */
export const transcribeRecording = async ({
  fetch,
  source,
  uri,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly uri: string;
}): Promise<Result<string, ApiError>> => {
  const form = new FormData();
  const file: RecordedFile = {
    uri,
    name: "dictation.m4a",
    type: "audio/mp4",
  };
  form.append("file", file);
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
