import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";
import {
  DOCUMENT_TRANSLATION_ENGINES,
  DOCUMENT_TRANSLATION_OUTPUTS,
} from "@/api/lib/document-translation/contract";

const languageCode = t.String({ minLength: 2, maxLength: 16 });

export const createDocumentTranslationRunBodySchema = t.Object({
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
  output: t.UnionEnum(DOCUMENT_TRANSLATION_OUTPUTS),
  engine: t.UnionEnum(DOCUMENT_TRANSLATION_ENGINES),
  sourceLang: t.Optional(languageCode),
  targetLang: languageCode,
});
