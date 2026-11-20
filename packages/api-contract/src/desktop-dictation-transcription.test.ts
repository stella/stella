import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  DESKTOP_DICTATION_MODELS_LABELED_QUERY,
  DESKTOP_DICTATION_MODELS_PATH,
  DESKTOP_DICTATION_MODELS_RETENTION_QUERY,
  DESKTOP_DICTATION_TRANSCRIBE_PATH,
  DESKTOP_DICTATION_TRANSCRIPT_AUDIO_PATH,
  DESKTOP_DICTATION_TRANSCRIPT_FOLDER_LIMITS,
  DESKTOP_DICTATION_TRANSCRIPT_LIMITS,
  DESKTOP_DICTATION_TRANSCRIPTS_PATH,
  desktopDictationModelsSchema,
  desktopDictationTranscriptAudioSchema,
  desktopDictationTranscriptCleanedSchema,
  desktopDictationTranscriptParagraphsSchema,
  desktopDictationTranscriptSavedSchema,
  MAX_DESKTOP_DICTATION_TRANSCRIPT_AUDIO_BYTES,
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
    transcriptAudioPath: DESKTOP_DICTATION_TRANSCRIPT_AUDIO_PATH,
    maxAudioBytes: MAX_TRANSCRIPTION_AUDIO_BYTES,
    maxAudioSeconds: MAX_TRANSCRIPTION_AUDIO_SECONDS,
    maxVocabularyTerms: MAX_TRANSCRIPTION_VOCABULARY_TERMS,
    maxVocabularyTermLength: MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
    maxTranscriptAudioBytes: MAX_DESKTOP_DICTATION_TRANSCRIPT_AUDIO_BYTES,
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

test("a folder takes bounded cleaned text and a declared recording", () => {
  const cleaned = (value: unknown) =>
    v.safeParse(desktopDictationTranscriptCleanedSchema, value).success;
  expect(cleaned({ markdown: "# Reply", instructions: [] })).toBe(true);
  expect(cleaned({ markdown: "   ", instructions: [] })).toBe(false);
  expect(
    cleaned({
      markdown: "Text",
      instructions: Array.from(
        {
          length: DESKTOP_DICTATION_TRANSCRIPT_FOLDER_LIMITS.instructions + 1,
        },
        () => "Make it an email.",
      ),
    }),
  ).toBe(false);
  const audio = {
    name: "Dictation.m4a",
    mimeType: "audio/mp4",
    size: 1024,
    sha256Hex: "a".repeat(64),
  };
  const declared = (value: unknown) =>
    v.safeParse(desktopDictationTranscriptAudioSchema, value).success;
  expect(declared(audio)).toBe(true);
  // A recording past the matter's limit is still declared, so the API can
  // answer that it was left out instead of refusing the documents.
  expect(
    declared({
      ...audio,
      size: MAX_DESKTOP_DICTATION_TRANSCRIPT_AUDIO_BYTES + 1,
    }),
  ).toBe(true);
  expect(declared({ ...audio, size: 0 })).toBe(false);
  expect(declared({ ...audio, sha256Hex: "A".repeat(64) })).toBe(false);
});

test("an older desktop reads only the file name of a filed transcript", () => {
  expect(
    v.parse(desktopDictationTranscriptSavedSchema, {
      fileName: "Memo transcript.docx",
    }),
  ).toStrictEqual({ fileName: "Memo transcript.docx" });
  expect(
    v.safeParse(desktopDictationTranscriptSavedSchema, {
      fileName: "Memo transcript.docx",
      folderName: "Memo",
      files: [{ kind: "transcript", fileName: "Memo transcript.docx" }],
      audio: { status: "too_large", maxBytes: 1 },
    }).success,
  ).toBe(true);
});

test("a folder reply names the cleaned-up text it could not file", () => {
  const reply = {
    fileName: "Memo transcript.docx",
    folderName: "Memo",
    files: [{ kind: "transcript", fileName: "Memo transcript.docx" }],
    notFiled: [{ kind: "cleaned", message: "No room left." }],
  } satisfies v.InferInput<typeof desktopDictationTranscriptSavedSchema>;
  expect(v.parse(desktopDictationTranscriptSavedSchema, reply)).toStrictEqual(
    reply,
  );
  // Only the cleaned-up text can be left out: the transcript is the save.
  expect(
    v.safeParse(desktopDictationTranscriptSavedSchema, {
      ...reply,
      notFiled: [{ kind: "transcript", message: "No room left." }],
    }).success,
  ).toBe(false);
});
