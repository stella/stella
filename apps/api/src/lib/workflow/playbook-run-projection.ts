import type { PlaybookRunProjection } from "@stll/api-contract";

import type { ConstantMap } from "@/api/lib/constant-map";

/**
 * The named projections, as `@stll/api-contract` declares them. The vocabulary
 * lives there because the request body and the control that sends it must be
 * one declaration; the map below is the naming convenience the server reads it
 * through.
 */
export const PLAYBOOK_RUN_PROJECTION = {
  COLUMNS: "columns",
  NONE: "none",
} as const satisfies ConstantMap<PlaybookRunProjection>;
