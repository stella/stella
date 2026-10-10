// parser-output-unchanged: Search guidance affects the MCP tool text only, not parsed records.
/**
 * Which query guidance `search_case_law` gives an agent.
 *
 * - `off` The tool describes itself as it did before guidance existed, and
 *         raises no `many_required_terms` warning.
 * - `v1`  The description says how a phrasing is matched (every required
 *         word in one passage) and how `limit` is shared, the court example
 *         names every admitted country's apex courts, and a long phrasing that
 *         fills fewer slots than it was given carries `many_required_terms`.
 *
 * Resolved once in `env-base`. A leaf module with no imports, because
 * `env-base` imports it.
 */
export const CASE_LAW_SEARCH_GUIDANCE_MODES = ["off", "v1"] as const;

export type CaseLawSearchGuidanceMode =
  (typeof CASE_LAW_SEARCH_GUIDANCE_MODES)[number];
