/**
 * Language-to-regconfig mapping for PostgreSQL full-text
 * search. Currently defaults to "simple" (no stemming) for
 * all documents because no reliable, maintained JS language
 * detection library exists.
 *
 * When a proper detection source is available (e.g.,
 * Elasticsearch, Meilisearch, or a future stable library),
 * replace the hardcoded fallback below.
 */

/**
 * ISO 639-1 code → PostgreSQL regconfig name.
 * Only languages with a built-in PG stemmer are listed;
 * everything else falls back to "simple" (no stemming).
 */
const REGCONFIG_MAP: Record<string, string> = {
  ar: "arabic",
  hy: "armenian",
  eu: "basque",
  ca: "catalan",
  da: "danish",
  nl: "dutch",
  en: "english",
  fi: "finnish",
  fr: "french",
  de: "german",
  el: "greek",
  hi: "hindi",
  hu: "hungarian",
  id: "indonesian",
  ga: "irish",
  it: "italian",
  lt: "lithuanian",
  ne: "nepali",
  nb: "norwegian",
  nn: "norwegian",
  no: "norwegian",
  pt: "portuguese",
  ro: "romanian",
  ru: "russian",
  sr: "serbian",
  es: "spanish",
  sv: "swedish",
  ta: "tamil",
  tr: "turkish",
  yi: "yiddish",
};

const FALLBACK_REGCONFIG = "simple";

/** Map an ISO 639-1 code to a PostgreSQL regconfig name. */
export const isoToRegconfig = (iso: string | null): string =>
  (iso && REGCONFIG_MAP[iso]) || FALLBACK_REGCONFIG;
