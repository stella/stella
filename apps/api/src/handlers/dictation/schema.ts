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
  TRANSCRIPTION_LABELS_SHOWN_FIELD,
} from "@stll/api-contract/transcription";
import { LANGUAGES } from "@stll/locales";

import { fileSchema, resourceIdSchema } from "@/api/lib/custom-schema";

export const dictationBodySchema = v.strictObject({
  file: v.pipe(
    fileSchema({ maxBytes: MAX_TRANSCRIPTION_AUDIO_BYTES }),
    v.minSize(1),
  ),
  /** Absent: the cheapest model offered in the organization's region. */
  modelId: v.optional(
    v.pipe(
      v.picklist(
        Object.keys(TRANSCRIPTION_MODELS).filter(isTranscriptionModelId),
      ),
      v.maxLength(MAX_TRANSCRIPTION_MODEL_ID_LENGTH),
    ),
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
  /** Present: the caller showed the models list's `outsideRegion` and
   *  `retainsData` labels where the model was chosen. */
  [TRANSCRIPTION_LABELS_SHOWN_FIELD]: v.optional(v.literal("1")),
});

/** What a linked desktop uploads: the audio chunk, a model and a language.
 *  It names no matter and sends no vocabulary, and its route always knows
 *  the desktop labels its models, so it sends no labels flag. */
export const desktopDictationBodySchema = v.omit(dictationBodySchema, [
  "matterId",
  "vocabulary",
  TRANSCRIPTION_LABELS_SHOWN_FIELD,
]);
