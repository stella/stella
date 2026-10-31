import * as v from "valibot";

import {
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import { jsonFromString } from "@stll/api-contract/http-input";
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_TRANSCRIPTION_MODEL_ID_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERMS,
} from "@stll/api-contract/transcription";
import { LANGUAGES } from "@stll/locales";

import { fileSchema, resourceIdSchema } from "@/api/lib/custom-schema";

export const dictationBodySchema = v.strictObject({
  file: v.pipe(
    fileSchema({ maxBytes: MAX_TRANSCRIPTION_AUDIO_BYTES }),
    v.minSize(1),
  ),
  modelId: v.pipe(
    v.picklist(
      Object.keys(TRANSCRIPTION_MODELS).filter(isTranscriptionModelId),
    ),
    v.maxLength(MAX_TRANSCRIPTION_MODEL_ID_LENGTH),
  ),
  language: v.optional(v.picklist(LANGUAGES.map(({ code }) => code))),
  vocabulary: v.optional(
    jsonFromString(
      v.pipe(
        v.array(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH),
          ),
        ),
        v.maxLength(MAX_TRANSCRIPTION_VOCABULARY_TERMS),
      ),
    ),
  ),
  matterId: v.optional(resourceIdSchema("workspace")),
});
