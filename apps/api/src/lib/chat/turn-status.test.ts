import { describe, expect, test } from "bun:test";

import {
  ACTIVE_CHAT_TURN_STATUSES,
  CHAT_TURN_LOG_IS_LIVE,
  CHAT_TURN_RUN_ENDING_STATUSES,
  CHAT_TURN_STATUSES,
  CHAT_TURN_TIMING_ACTIVE_STATUSES,
  type ChatTurnStatus,
} from "./turn-status";

const isActive = (status: ChatTurnStatus) =>
  ACTIVE_CHAT_TURN_STATUSES.some((active) => active === status);

describe("a handed-over chat turn", () => {
  test("is unsettled: its thread takes no other turn, its queue waits", () => {
    expect(isActive("handed-over")).toBe(true);
  });

  test("keeps its run on the computer, and its active time running", () => {
    expect(CHAT_TURN_RUN_ENDING_STATUSES).not.toContain("handed-over");
    expect(CHAT_TURN_TIMING_ACTIVE_STATUSES).toContain("handed-over");
  });

  test("keeps its run log live for a viewer to tail through the gap", () => {
    expect(CHAT_TURN_LOG_IS_LIVE["handed-over"]).toBe(true);
  });
});

test("only an unsettled turn can have a live run log", () => {
  for (const status of CHAT_TURN_STATUSES) {
    if (CHAT_TURN_LOG_IS_LIVE[status]) {
      expect(isActive(status)).toBe(true);
    }
  }
});
