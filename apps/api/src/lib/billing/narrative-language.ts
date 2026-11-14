import * as v from "valibot";

export const NARRATIVE_LANGUAGE_MAX_LENGTH = 64;
export const NARRATIVE_LANGUAGE_PATTERN =
  "^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$";

export const narrativeLanguageSchema = v.nullable(
  v.pipe(
    v.string(),
    v.minLength(2),
    v.maxLength(NARRATIVE_LANGUAGE_MAX_LENGTH),
    v.regex(new RegExp(NARRATIVE_LANGUAGE_PATTERN, "u")),
    v.description("BCP-47 language tag, or null when unspecified"),
  ),
);
