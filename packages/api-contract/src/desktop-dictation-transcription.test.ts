import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  DESKTOP_DICTATION_MODELS_PATH,
  DESKTOP_DICTATION_TRANSCRIBE_PATH,
  desktopDictationModelsSchema,
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

test("a model may name its provider and that it runs outside the region", () => {
  const listed = {
    models: [
      { id: "mistralai/voxtral-mini-transcribe", displayName: "Voxtral" },
      {
        id: "google/chirp-3",
        displayName: "Chirp 3",
        provider: "Google",
        outsideRegion: true,
      },
    ],
    defaultModelId: "mistralai/voxtral-mini-transcribe",
    unavailable: null,
  };
  expect(v.parse(desktopDictationModelsSchema, listed)).toStrictEqual(listed);
  expect(
    v.safeParse(desktopDictationModelsSchema, {
      ...listed,
      models: [{ ...listed.models[1], provider: "" }],
    }).success,
  ).toBe(false);
});
