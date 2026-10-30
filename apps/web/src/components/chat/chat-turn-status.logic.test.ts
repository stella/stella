import { expect, test } from "bun:test";

import {
  turnLiveStatus,
  turnPhaseForTool,
} from "@/components/chat/chat-turn-status.logic";

test("maps every SDK chat state to one live line or no line", () => {
  expect(turnLiveStatus({ state: "ready", phase: null })).toEqual({
    type: "none",
  });
  expect(turnLiveStatus({ state: "error", phase: null })).toEqual({
    type: "none",
  });
  expect(turnLiveStatus({ state: "submitted", phase: null })).toEqual({
    type: "live",
    phase: { type: "thinking" },
  });
  expect(turnLiveStatus({ state: "streaming", phase: null })).toEqual({
    type: "live",
    phase: { type: "writing" },
  });
});

test("maps every SDK tool state exhaustively", () => {
  expect([
    turnPhaseForTool("awaiting-input", "Search"),
    turnPhaseForTool("input-streaming", "Search"),
    turnPhaseForTool("input-complete", "Search"),
    turnPhaseForTool("approval-requested", "Search"),
    turnPhaseForTool("approval-responded", "Search"),
    turnPhaseForTool("complete", "Search"),
    turnPhaseForTool("error", "Search"),
  ]).toEqual([
    { type: "waiting-for-input" },
    { type: "using-tool", label: "Search" },
    { type: "using-tool", label: "Search" },
    { type: "waiting-for-approval" },
    { type: "using-tool", label: "Search" },
    null,
    null,
  ]);
});
