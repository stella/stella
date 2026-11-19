import { describe, expect, test } from "bun:test";

import { subagentReport } from "./items";

const TRAILER =
  "agentId: a1b2c3 (use SendMessage with to: 'a1b2c3', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: 1200\ntool_uses: 3\nduration_ms: 4500</usage>";

const FRAME =
  "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:";

describe("a subagent's report", () => {
  test("loses the agent id and usage the CLI appends for the parent model", () => {
    // The result's blocks are joined as they come: the trailer is its own.
    expect(subagentReport(`The leases are in /contracts.${TRAILER}`)).toBe(
      "The leases are in /contracts.",
    );
    expect(
      subagentReport(
        `Done.\nagentId: a1b2c3\nworktreePath: /tmp/w\nworktreeBranch: agent-a1\n<usage>subagent_tokens: 1</usage>`,
      ),
    ).toBe("Done.");
  });

  test("comes out of the hand-back frame and its indent, notes above it dropped", () => {
    const framed = [
      "  This agent read text from another device.",
      FRAME,
      "  Two leases:",
      "  ",
      "    - the office",
      "  - the warehouse",
    ].join("\n");
    expect(subagentReport(`${framed}\n${TRAILER}`)).toBe(
      ["Two leases:", "", "  - the office", "- the warehouse"].join("\n"),
    );
  });

  test("written by the subagent alone is kept as it is", () => {
    for (const report of [
      "Plain report.",
      "The note names agentId: x7 for the clerk.",
      "The clerk's note names agentId: x7",
      "Done.\nagentId: x7",
      // A frame line inside a framed report is indented, so it is the
      // subagent's text, never the CLI's.
      "  [Subagent hand-back] quoted",
    ]) {
      expect(subagentReport(report)).toBe(report);
    }
  });
});
