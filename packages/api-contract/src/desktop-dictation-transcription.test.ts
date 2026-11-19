import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  DESKTOP_DICTATION_MODELS_LABELED_QUERY,
  DESKTOP_DICTATION_MODELS_PATH,
  DESKTOP_DICTATION_MODELS_RETENTION_QUERY,
  DESKTOP_DICTATION_TRANSCRIBE_PATH,
  DESKTOP_DICTATION_TRANSCRIPT_LIMITS,
  DESKTOP_DICTATION_TRANSCRIPTS_PATH,
  desktopDictationModelsSchema,
  desktopDictationTranscriptParagraphsSchema,
} from "./desktop-dictation-transcription";
import contract from "./desktop-dictation-transcription.json";
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_TRANSCRIPTION_AUDIO_SECONDS,
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERMS,
} from "./transcription";

test("the typed transcription contract reads the native one", () => {
  expect(contract).toStrictEqual({
    modelsPath: DESKTOP_DICTATION_MODELS_PATH,
    modelsLabeledQuery: DESKTOP_DICTATION_MODELS_LABELED_QUERY,
    modelsRetentionQuery: DESKTOP_DICTATION_MODELS_RETENTION_QUERY,
    transcribePath: DESKTOP_DICTATION_TRANSCRIBE_PATH,
    transcriptsPath: DESKTOP_DICTATION_TRANSCRIPTS_PATH,
    maxAudioBytes: MAX_TRANSCRIPTION_AUDIO_BYTES,
    maxAudioSeconds: MAX_TRANSCRIPTION_AUDIO_SECONDS,
    maxVocabularyTerms: MAX_TRANSCRIPTION_VOCABULARY_TERMS,
    maxVocabularyTermLength: MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
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
      {
        id: "elevenlabs-direct/scribe-v3",
        displayName: "Scribe v3",
        provider: "ElevenLabs",
        outsideRegion: false,
        retainsData: true,
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

test("a transcript has paragraphs within a four-hour recording", () => {
  const paragraph = { startMs: 0, text: "Memo to file." };
  const valid = (paragraphs: unknown) =>
    v.safeParse(desktopDictationTranscriptParagraphsSchema, paragraphs).success;
  expect(valid([paragraph])).toBe(true);
  expect(valid([])).toBe(false);
  expect(valid([{ ...paragraph, startMs: -1 }])).toBe(false);
  expect(valid([{ ...paragraph, startMs: 1.5 }])).toBe(false);
  expect(
    valid([
      {
        ...paragraph,
        startMs: DESKTOP_DICTATION_TRANSCRIPT_LIMITS.maxStartMs + 1,
      },
    ]),
  ).toBe(false);
  expect(
    valid([
      {
        ...paragraph,
        text: "a".repeat(DESKTOP_DICTATION_TRANSCRIPT_LIMITS.paragraphLength),
      },
    ]),
  ).toBe(true);
  const longest = "a".repeat(
    DESKTOP_DICTATION_TRANSCRIPT_LIMITS.paragraphLength,
  );
  const tooMuch = Array.from(
    {
      length:
        DESKTOP_DICTATION_TRANSCRIPT_LIMITS.totalLength /
          DESKTOP_DICTATION_TRANSCRIPT_LIMITS.paragraphLength +
        1,
    },
    (_unused, index) => ({ startMs: index * 1000, text: longest }),
  );
  expect(valid(tooMuch)).toBe(false);
});
