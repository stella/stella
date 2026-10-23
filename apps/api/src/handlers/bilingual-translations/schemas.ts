import * as v from "valibot";

import {
  BILINGUAL_GLOSSARY_ORIGINS,
  BILINGUAL_LIMITS,
  BILINGUAL_ROW_DISPOSITIONS,
} from "@/api/lib/bilingual/contract";
import { resourceIdSchema } from "@/api/lib/custom-schema";

/** IETF-style language tag; also the cloned style suffix folio used. */
const LANGUAGE_TAG_PATTERN = "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$";

const languageTagSchema = v.pipe(
  v.string(),
  v.minLength(2),
  v.maxLength(16),
  v.regex(new RegExp(LANGUAGE_TAG_PATTERN, "u")),
);

const termSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(BILINGUAL_LIMITS.termMax),
);

const glossaryEntrySchema = v.object({
  source: termSchema,
  target: termSchema,
  sourceForms: v.pipe(
    v.array(termSchema),
    v.maxLength(BILINGUAL_LIMITS.formsMax),
  ),
  targetForms: v.pipe(
    v.array(termSchema),
    v.maxLength(BILINGUAL_LIMITS.formsMax),
  ),
  origin: v.picklist(BILINGUAL_GLOSSARY_ORIGINS),
});

export const prepareBilingualTranslationBodySchema = v.object({
  entityId: resourceIdSchema("entity"),
  fieldId: resourceIdSchema("field"),
  sourceLang: languageTagSchema,
  targetLang: languageTagSchema,
});

export const createBilingualRunBodySchema = v.object({
  entityId: resourceIdSchema("entity"),
  fieldId: resourceIdSchema("field"),
  entityVersionId: resourceIdSchema("entityVersion"),
  sourceLang: languageTagSchema,
  targetLang: languageTagSchema,
  glossary: v.pipe(
    v.array(glossaryEntrySchema),
    v.maxLength(BILINGUAL_LIMITS.glossaryMax),
  ),
  rows: v.pipe(
    v.array(
      v.object({
        rowId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
        disposition: v.picklist(BILINGUAL_ROW_DISPOSITIONS),
      }),
    ),
    v.minLength(1),
    v.maxLength(BILINGUAL_LIMITS.rowsMax),
  ),
});
