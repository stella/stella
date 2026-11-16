import type { ToolCallState } from "@tanstack/ai-client";
import { expect, test } from "bun:test";

import type { TurnActivePhase } from "@/components/chat/chat-turn-status.logic";
import {
  turnLiveStatus,
  turnPhaseForTool,
  turnPhaseFromParts,
} from "@/components/chat/chat-turn-status.logic";
import type { ChatPart } from "@/components/chat/chat-ui-tools";

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

const toolCases = {
  "awaiting-input": {
    state: "awaiting-input",
    phase: { type: "using-tool", label: "Search" },
  },
  "input-streaming": {
    state: "input-streaming",
    phase: { type: "using-tool", label: "Search" },
  },
  "input-complete": {
    state: "input-complete",
    phase: { type: "using-tool", label: "Search" },
  },
  "approval-requested": {
    state: "approval-requested",
    phase: { type: "waiting-for-approval" },
  },
  "approval-responded": {
    state: "approval-responded",
    phase: { type: "using-tool", label: "Search" },
  },
  complete: { state: "complete", phase: null },
  error: { state: "error", phase: null },
} as const satisfies {
  [State in ToolCallState]: { state: State; phase: TurnActivePhase | null };
};

test("maps every SDK tool state exhaustively from real message parts", () => {
  for (const { state, phase } of Object.values(toolCases)) {
    expect(turnPhaseForTool(state, "Search")).toEqual(phase);
    expect(
      turnPhaseFromParts(
        [
          {
            type: "tool-call",
            id: "lookup",
            name: "read_document",
            arguments: "{}",
            state,
          },
        ],
        () => "Search",
      ),
    ).toEqual(
      phase ??
        (state === "complete"
          ? { type: "analyzing-sources" }
          : { type: "thinking" }),
    );
  }
});

const partCases = {
  text: {
    part: { type: "text", content: "Answer" },
    phase: { type: "writing" },
  },
  thinking: {
    part: { type: "thinking", content: "Reasoning" },
    phase: { type: "thinking" },
  },
  "tool-call": {
    part: {
      type: "tool-call",
      id: "lookup",
      name: "read_document",
      arguments: "{}",
      state: "input-complete",
    },
    phase: { type: "using-tool", label: "Search" },
  },
  "tool-result": {
    part: {
      type: "tool-result",
      toolCallId: "lookup",
      content: "Result",
      state: "complete",
    },
    phase: { type: "thinking" },
  },
  activity: {
    part: { type: "activity", activityType: "review", content: {} },
    phase: { type: "thinking" },
  },
  image: {
    part: {
      type: "image",
      source: { type: "url", value: "https://example.test/image.png" },
    },
    phase: { type: "thinking" },
  },
  audio: {
    part: {
      type: "audio",
      source: { type: "url", value: "https://example.test/audio.mp3" },
    },
    phase: { type: "thinking" },
  },
  video: {
    part: {
      type: "video",
      source: { type: "url", value: "https://example.test/video.mp4" },
    },
    phase: { type: "thinking" },
  },
  document: {
    part: {
      type: "document",
      source: { type: "url", value: "https://example.test/document.pdf" },
    },
    phase: { type: "thinking" },
  },
  "ui-resource": {
    part: {
      type: "ui-resource",
      resource: {
        uri: "ui://stella/overview",
        mimeType: "text/html",
        text: "Overview",
      },
      toolCallId: "visual",
      toolName: "show_visual",
    },
    phase: { type: "writing" },
  },
  "structured-output": {
    part: { type: "structured-output", status: "streaming", raw: "{}" },
    phase: { type: "writing" },
  },
  subagent: {
    part: {
      type: "subagent",
      subagent: {
        id: "child",
        name: "Research",
        status: "running",
        messages: [],
      },
    },
    phase: { type: "thinking" },
  },
} as const satisfies {
  [Kind in ChatPart["type"]]: {
    part: Extract<ChatPart, { type: Kind }>;
    phase: TurnActivePhase;
  };
};

test("every part kind has an explicit phase policy", () => {
  for (const { part, phase } of Object.values(partCases)) {
    expect(turnPhaseFromParts([part], () => "Search")).toEqual(phase);
  }
  expect(turnPhaseFromParts([], () => "Search")).toEqual({ type: "thinking" });
});

test("active tools win over earlier text and later incidental parts", () => {
  expect(
    turnPhaseFromParts(
      [
        partCases.text.part,
        partCases["tool-call"].part,
        partCases.activity.part,
      ],
      () => "Search",
    ),
  ).toEqual({ type: "using-tool", label: "Search" });
  expect(
    turnPhaseFromParts(
      [
        { ...partCases["tool-call"].part, state: "complete" },
        partCases.text.part,
      ],
      () => "Search",
    ),
  ).toEqual({ type: "writing" });
  expect(
    turnPhaseFromParts(
      [
        partCases.text.part,
        { ...partCases["tool-call"].part, state: "complete" },
      ],
      () => "Search",
    ),
  ).toEqual({ type: "analyzing-sources" });
  expect(
    turnPhaseFromParts(
      [{ ...partCases["tool-call"].part, name: "ask-user" }],
      () => "Question",
    ),
  ).toEqual({ type: "waiting-for-input" });
  expect(
    turnPhaseFromParts(
      [
        { ...partCases["tool-call"].part, id: "older" },
        {
          ...partCases["tool-call"].part,
          id: "newer",
          name: "mcp__registry__search",
          state: "approval-requested",
        },
      ],
      () => "Registry",
    ),
  ).toEqual({ type: "waiting-for-approval" });
});
