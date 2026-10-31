import { describe, expect, test } from "bun:test";

import { createTestState } from "@stll/test-state";

import { readParsedInputStateBackfillEnvironment } from "@/api/env-parsed-input-state-backfill";

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
