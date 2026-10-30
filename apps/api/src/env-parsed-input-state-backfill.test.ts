import { describe, expect, test } from "bun:test";

import { readParsedInputStateBackfillEnvironment } from "@/api/env-parsed-input-state-backfill";
import { createTestState } from "@/api/tests/helpers/test-state";

const state = createTestState({ file: import.meta.path, config: {} });

describe("parsed-input-state backfill environment", () => {
  test("defaults the kill switch to false", () => {
    state.deleteEnv("CASE_LAW_PARSED_INPUT_STATE_BACKFILL_KILL_SWITCH");
    expect(readParsedInputStateBackfillEnvironment()).toEqual({
      CASE_LAW_PARSED_INPUT_STATE_BACKFILL_KILL_SWITCH: false,
    });
  });

  test("parses an enabled kill switch", () => {
    state.setEnv("CASE_LAW_PARSED_INPUT_STATE_BACKFILL_KILL_SWITCH", "true");
    expect(readParsedInputStateBackfillEnvironment()).toEqual({
      CASE_LAW_PARSED_INPUT_STATE_BACKFILL_KILL_SWITCH: true,
    });
  });
});
