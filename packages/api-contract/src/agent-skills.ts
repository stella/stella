/**
 * Link target prefix of a skill chip, the markdown link
 * `[label](#stella-skill-ref=slug)` prompt inputs write for a picked skill and
 * the API and chat renderer read back. A hash fragment, so Markdown sanitizers
 * keep it.
 */
export const SKILL_REF_HREF_PREFIX = "#stella-skill-ref=";

/** Browser-safe path grammar shared by skill-resource producers and editors. */
export const SKILL_RESOURCE_PATH_PATTERN =
  /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;
