import { t } from "elysia";

export const NARRATIVE_LANGUAGE_MAX_LENGTH = 64;
export const NARRATIVE_LANGUAGE_PATTERN =
  "^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$";

export const narrativeLanguageSchema = t.Nullable(
  t.String({
    minLength: 2,
    maxLength: NARRATIVE_LANGUAGE_MAX_LENGTH,
    pattern: NARRATIVE_LANGUAGE_PATTERN,
    description: "BCP-47 language tag, or null when unspecified",
  }),
);
