import { t } from "elysia";

export const timeSuggestionDateSchema = t.String({
  format: "date",
  description: "Day the suggestions are computed for (ISO YYYY-MM-DD)",
});

export const timeSuggestionTimezoneSchema = t.String({
  minLength: 1,
  maxLength: 64,
  description:
    "IANA time zone that bounds the day (e.g. Europe/Prague); an accepted entry is dated in it",
});

export const timeSuggestionFingerprintSchema = t.String({
  pattern: "^[0-9a-f]{64}$",
  description: "Fingerprint of a suggestion from time-entries.suggestions.list",
});
