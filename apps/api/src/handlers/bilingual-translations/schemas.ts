import { t } from "elysia";

import {
  BILINGUAL_GLOSSARY_ORIGINS,
  BILINGUAL_LIMITS,
  BILINGUAL_ROW_DISPOSITIONS,
} from "@/api/lib/bilingual/contract";
import { tSafeId } from "@/api/lib/custom-schema";

/** IETF-style language tag; also the cloned style suffix folio used. */
const LANGUAGE_TAG_PATTERN = "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$";

export const languageTagSchema = t.String({
  minLength: 2,
  maxLength: 16,
  pattern: LANGUAGE_TAG_PATTERN,
});

const termSchema = t.String({
  minLength: 1,
  maxLength: BILINGUAL_LIMITS.termMax,
});

export const glossaryEntrySchema = t.Object({
  source: termSchema,
  target: termSchema,
  sourceForms: t.Array(termSchema, { maxItems: BILINGUAL_LIMITS.formsMax }),
  targetForms: t.Array(termSchema, { maxItems: BILINGUAL_LIMITS.formsMax }),
  origin: t.UnionEnum(BILINGUAL_GLOSSARY_ORIGINS),
});

export const prepareBilingualTranslationBodySchema = t.Object({
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
  sourceLang: languageTagSchema,
  targetLang: languageTagSchema,
});

export const createBilingualRunBodySchema = t.Object({
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
  entityVersionId: tSafeId("entityVersion"),
  sourceLang: languageTagSchema,
  targetLang: languageTagSchema,
  glossary: t.Array(glossaryEntrySchema, {
    maxItems: BILINGUAL_LIMITS.glossaryMax,
  }),
  rows: t.Array(
    t.Object({
      rowId: t.String({ minLength: 1, maxLength: 64 }),
      disposition: t.UnionEnum(BILINGUAL_ROW_DISPOSITIONS),
    }),
    { minItems: 1, maxItems: BILINGUAL_LIMITS.rowsMax },
  ),
});
