// OpenRouter's STT guide documents a 60-second processing deadline (2026-10-29):
// https://openrouter.ai/docs/guides/overview/multimodal/stt
// Catalog models do not promise a processing/audio speed ratio. Use a conservative
// real-time chunk ceiling; this is an audio policy bound, not a throughput guarantee.
export const MAX_TRANSCRIPTION_AUDIO_SECONDS = 60;

export const MAX_TRANSCRIPTION_PROVIDER_BODY_BYTES = 25 * 1024 * 1024;
export const MAX_TRANSCRIPTION_VOCABULARY_TERMS = 100;
/** Lengths are UTF-16 code units, matching JavaScript string validation. */
export const MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH = 100;
export const MAX_TRANSCRIPTION_MODEL_ID_LENGTH = 128;

// A control character or unpaired surrogate takes six bytes in escaped JSON.
const MAX_JSON_BYTES_PER_CODE_UNIT = 6;
const MAX_VOCABULARY_JSON_CONTENT_BYTES =
  MAX_TRANSCRIPTION_VOCABULARY_TERMS *
    (2 +
      MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH * MAX_JSON_BYTES_PER_CODE_UNIT) +
  MAX_TRANSCRIPTION_VOCABULARY_TERMS -
  1;

// Azure's phrase list has the largest wrapper, including list quotes and commas.
const MAX_PROVIDER_ENVELOPE_BYTES =
  '{"model":"","input_audio":{"data":"","format":"webm"},"language":"aa","response_format":"verbose_json","timestamp_granularities":["segment","word"],"provider":{"zdr":true,"data_collection":"deny","options":{"azure":{"phraseList":{"phrases":[]}}}}}'
    .length +
  MAX_TRANSCRIPTION_MODEL_ID_LENGTH * MAX_JSON_BYTES_PER_CODE_UNIT +
  MAX_VOCABULARY_JSON_CONTENT_BYTES;

/** Includes base64 padding and every bounded provider request field. */
export const MAX_TRANSCRIPTION_AUDIO_BYTES =
  3 *
  Math.floor(
    (MAX_TRANSCRIPTION_PROVIDER_BODY_BYTES - MAX_PROVIDER_ENVELOPE_BYTES) / 4,
  );

// Five form parts: file, model, language, vocabulary JSON, and a matter UUID.
const MULTIPART_PARTS = 5;
const MULTIPART_BOUNDARY_LENGTH = 70;
const MULTIPART_PART_HEADER_BYTES = 512;
const MULTIPART_FRAMING_BYTES =
  MULTIPART_PARTS *
    (2 * MULTIPART_BOUNDARY_LENGTH + MULTIPART_PART_HEADER_BYTES + 16) +
  MULTIPART_BOUNDARY_LENGTH +
  8;
const MAX_MULTIPART_METADATA_BYTES =
  3 * MAX_TRANSCRIPTION_MODEL_ID_LENGTH +
  2 +
  36 +
  2 +
  MAX_VOCABULARY_JSON_CONTENT_BYTES;

/** Framing is bounded independently of the parsed file's byte limit. */
export const MAX_TRANSCRIPTION_MULTIPART_BYTES =
  MAX_TRANSCRIPTION_AUDIO_BYTES +
  MAX_MULTIPART_METADATA_BYTES +
  MULTIPART_FRAMING_BYTES;
