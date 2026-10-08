import * as v from "valibot";

import { featureFlagSchema } from "@/api/env-base-schema";

export const euCompletionTickServerSchema = {
  CASE_LAW_EU_COMPLETION_ENABLED: featureFlagSchema,
  CASE_LAW_EU_COMPLETION_KILL_SWITCH: featureFlagSchema,
  CASE_LAW_EU_COMPLETION_MODE: v.optional(
    v.picklist(["dry-run", "apply"]),
    "dry-run",
  ),
  CASE_LAW_EU_COMPLETION_MAX_ROWS: v.pipe(
    v.optional(v.string(), "25"),
    v.transform(Number),
    v.integer(),
    v.minValue(1),
    v.maxValue(100),
  ),
};

const environmentSchema = v.object(euCompletionTickServerSchema);

/** Runtime switches never grant supervised approval; the receipt store owns it. */
export const readEuCompletionTickEnvironment = () =>
  v.parse(environmentSchema, {
    CASE_LAW_EU_COMPLETION_ENABLED:
      process.env["CASE_LAW_EU_COMPLETION_ENABLED"],
    CASE_LAW_EU_COMPLETION_KILL_SWITCH:
      process.env["CASE_LAW_EU_COMPLETION_KILL_SWITCH"],
    CASE_LAW_EU_COMPLETION_MODE: process.env["CASE_LAW_EU_COMPLETION_MODE"],
    CASE_LAW_EU_COMPLETION_MAX_ROWS:
      process.env["CASE_LAW_EU_COMPLETION_MAX_ROWS"],
  });
