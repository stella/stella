import { TaggedError } from "better-result";

/**
 * A provider could not produce browse facets. Facet counts are a navigation
 * aid, not the page's content, so callers are expected to degrade to an empty
 * facet set rather than fail the request — the error carries the reason so the
 * degradation is logged instead of silent.
 */
export class LegalBrowseFacetsError extends TaggedError(
  "LegalBrowseFacetsError",
)<{
  message: string;
  cause?: unknown;
}> {}
