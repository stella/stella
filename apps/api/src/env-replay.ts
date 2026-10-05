import * as v from "valibot";

import { featureFlagSchema } from "@/api/env-base-schema";

export const replayTickServerSchema = {
  CASE_LAW_REPLAY_ENABLED: featureFlagSchema,
  CASE_LAW_REPLAY_KILL_SWITCH: featureFlagSchema,
  CASE_LAW_REPLAY_DISABLED_SOURCES: v.optional(v.string(), ""),
};

const replayTickEnvironmentSchema = v.object(replayTickServerSchema);

/** Re-read kill switches at batch boundaries rather than caching startup state. */
export const readReplayTickEnvironment = () =>
  v.parse(replayTickEnvironmentSchema, {
    CASE_LAW_REPLAY_ENABLED: process.env["CASE_LAW_REPLAY_ENABLED"],
    CASE_LAW_REPLAY_KILL_SWITCH: process.env["CASE_LAW_REPLAY_KILL_SWITCH"],
    CASE_LAW_REPLAY_DISABLED_SOURCES:
      process.env["CASE_LAW_REPLAY_DISABLED_SOURCES"],
  });
