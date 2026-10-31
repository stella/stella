import * as v from "valibot";

import { featureFlagSchema } from "@/api/env-base-schema";

export const parsedInputStateBackfillServerSchema = {
  CASE_LAW_PARSED_INPUT_STATE_BACKFILL_KILL_SWITCH: featureFlagSchema,
};

const environmentSchema = v.object(parsedInputStateBackfillServerSchema);

export const readParsedInputStateBackfillEnvironment = () =>
  v.parse(environmentSchema, {
    CASE_LAW_PARSED_INPUT_STATE_BACKFILL_KILL_SWITCH:
      process.env["CASE_LAW_PARSED_INPUT_STATE_BACKFILL_KILL_SWITCH"],
  });
