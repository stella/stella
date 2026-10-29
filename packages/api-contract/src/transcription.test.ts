import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_TRANSCRIPTION_MODEL_ID_LENGTH,
  MAX_TRANSCRIPTION_MULTIPART_BYTES,
  MAX_TRANSCRIPTION_PROVIDER_BODY_BYTES,
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERMS,
} from "./transcription";

const largestVocabulary = Array.from(
  { length: MAX_TRANSCRIPTION_VOCABULARY_TERMS },
  () => "\u0000".repeat(MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH),
);

const maximumProviderBody = (audioBytes: number) =>
  JSON.stringify({
    model: "\u0000".repeat(MAX_TRANSCRIPTION_MODEL_ID_LENGTH),
    input_audio: {
      data: "A".repeat(4 * Math.ceil(audioBytes / 3)),
      format: "webm",
    },
    language: "aa",
    response_format: "verbose_json",
    timestamp_granularities: ["segment", "word"],
    provider: {
      zdr: true,
      data_collection: "deny",
      options: { azure: { phraseList: { phrases: largestVocabulary } } },
    },
  });

test("transcription audio maximum fits a complete escaped provider request", () => {
  expect(
    Buffer.byteLength(maximumProviderBody(MAX_TRANSCRIPTION_AUDIO_BYTES)),
  ).toBeLessThanOrEqual(MAX_TRANSCRIPTION_PROVIDER_BODY_BYTES);
  expect(
    Buffer.byteLength(maximumProviderBody(MAX_TRANSCRIPTION_AUDIO_BYTES + 1)),
  ).toBeGreaterThan(MAX_TRANSCRIPTION_PROVIDER_BODY_BYTES);
});

test("transcription JSON size bound covers every UTF-16 spelling", () => {
  assertProperty(
    "transcription JSON size bound covers every UTF-16 spelling",
    fc.property(
      fc.array(fc.integer({ min: 0, max: 0xff_ff }), {
        maxLength: MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
      }),
      (codeUnits) => {
        const term = String.fromCodePoint(...codeUnits);
        expect(Buffer.byteLength(JSON.stringify(term))).toBeLessThanOrEqual(
          2 + 6 * term.length,
        );
      },
    ),
  );
});

test("transcription vocabulary envelope bounds every provider option mechanism", () => {
  const azureOptions = {
    azure: { phraseList: { phrases: largestVocabulary } },
  };
  const options = [
    {},
    { groq: { prompt: largestVocabulary.join(", ") } },
    { openai: { prompt: largestVocabulary.join(", ") } },
    azureOptions,
  ];
  const azureBytes = Buffer.byteLength(JSON.stringify(azureOptions));
  for (const option of options) {
    expect(Buffer.byteLength(JSON.stringify(option))).toBeLessThanOrEqual(
      azureBytes,
    );
  }
});

test("transcription multipart maximum fits full vocabulary and maximum audio", async () => {
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES)]),
    "diktát.wav",
  );
  form.set("model", "m".repeat(MAX_TRANSCRIPTION_MODEL_ID_LENGTH));
  form.set("language", "cs");
  form.set("vocabulary", JSON.stringify(largestVocabulary));
  form.set("matterId", "00000000-0000-4000-8000-000000000001");
  const request = new Request("http://localhost/transcriptions", {
    method: "POST",
    body: form,
  });
  expect((await request.arrayBuffer()).byteLength).toBeLessThanOrEqual(
    MAX_TRANSCRIPTION_MULTIPART_BYTES,
  );
});
