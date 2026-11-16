import * as v from "valibot";

import { API_CALENDAR_DATE_CHECK } from "@stll/api-contract/api-date";

export const timeSuggestionDateSchema = v.pipe(
  v.string(),
  v.isoDate(),
  API_CALENDAR_DATE_CHECK,
  v.description("Day the suggestions are computed for (ISO YYYY-MM-DD)"),
);

export const timeSuggestionTimezoneSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.description(
    "IANA time zone that bounds the day (e.g. Europe/Prague); an accepted entry is dated in it",
  ),
);

export const timeSuggestionFingerprintSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{64}$/u),
  v.description(
    "Fingerprint of a suggestion from time-entries.suggestions.list",
  ),
);
