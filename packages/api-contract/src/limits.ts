/**
 * Bounds the server enforces and the client also has to know.
 *
 * Each value here was a literal copied into apps/web with a comment naming
 * the API-side constant it tracked. A comment is not a check: a raised or
 * lowered server bound leaves the copy compiling and silently wrong, so the
 * client under- or over-fetches, or disables a control at the wrong count.
 * Both sides import from here instead; apps/api re-exports them through its
 * own `LIMITS` so server call sites keep one lookup table.
 */

/** Max input documents a single flow run may be launched against. */
export const FLOW_RUN_INPUT_ENTITIES_MAX = 50;

/**
 * Enabled installed skills the chat backend exposes to `load-skill`. The
 * composer's slash menu must not offer a skill the model cannot load.
 */
export const AGENT_SKILLS_CHAT_METADATA_MAX = 200;

/** Max page size for one entity's DOCX suggestion list. */
export const DOCX_SUGGESTIONS_PAGE_SIZE_MAX = 200;

/**
 * Per-organization cap on matters (workspaces), enforced on create. The client
 * hides "new matter" surfaces at the cap.
 */
export const WORKSPACES_PER_ORGANIZATION_MAX = 1000;

/**
 * Max properties (columns) one matter may define. The client disables the
 * add-column affordances at the cap; the server rejects past it.
 */
export const PROPERTIES_PER_WORKSPACE_MAX = 20;

/**
 * Max entities (rows) one matter may hold. The client disables the
 * add-row affordances at the cap; the server rejects past it.
 */
export const ENTITIES_PER_WORKSPACE_MAX = 10_000;

/**
 * Years covered by a decision's incoming-citation timeline, ending with the
 * current year. The server aggregates only this span; the client draws only
 * this span, so an old decision does not stretch the strip back to its date.
 */
export const CASE_LAW_CITATION_TIMELINE_MAX_YEARS = 60;
