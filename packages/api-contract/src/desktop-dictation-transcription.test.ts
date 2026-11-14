import { expect, test } from "bun:test";

import {
  DESKTOP_DICTATION_MODELS_PATH,
  DESKTOP_DICTATION_TRANSCRIBE_PATH,
} from "./desktop-dictation-transcription";
import contract from "./desktop-dictation-transcription.json";
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_TRANSCRIPTION_AUDIO_SECONDS,
} from "./transcription";

test("the typed transcription contract reads the native one", () => {
  expect(contract).toStrictEqual({
    modelsPath: DESKTOP_DICTATION_MODELS_PATH,
    transcribePath: DESKTOP_DICTATION_TRANSCRIBE_PATH,
    maxAudioBytes: MAX_TRANSCRIPTION_AUDIO_BYTES,
    maxAudioSeconds: MAX_TRANSCRIPTION_AUDIO_SECONDS,
  });
});
