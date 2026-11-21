import { describe, expect, test } from "bun:test";

import { localRunQuestionCallId } from "@/components/chat/local-run-question.logic";

describe("a local run's question pause", () => {
  test("belongs to the message's open question call, not an answered one", () => {
    expect(
      localRunQuestionCallId([
        { type: "text" },
        {
          type: "tool-call",
          id: "answered",
          name: "request_user_input",
          state: "complete",
        },
        {
          type: "tool-call",
          id: "command",
          name: "command_execution",
          state: "input-complete",
        },
        {
          type: "tool-call",
          id: "open",
          name: "request_user_input",
          state: "input-complete",
        },
      ]),
    ).toBe("open");
    expect(
      localRunQuestionCallId([
        {
          type: "tool-call",
          id: "answered",
          name: "request_user_input",
          state: "complete",
        },
      ]),
    ).toBeNull();
  });
});
