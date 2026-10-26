import { describe, expect, test } from "bun:test";

import {
  countProcessWork,
  getChatToolActivityCategory,
  getLatestCompletedResearchPartIndex,
  resolveChatActivityIndicatorState,
} from "@/components/chat/chat-activity.logic";
import { projectCanonicalChatUIMessages } from "@/components/chat/chat-ui-tools";
import type { ChatMessage } from "@/components/chat/chat-ui-tools";

// Fixtures cross the same projection boundary the thread renders through.
const projectParts = (parts: ChatMessage["parts"]) =>
  projectCanonicalChatUIMessages([
    { id: "message", parts, role: "assistant" },
  ]).flatMap((message) => message.parts);

describe("chat tool activity", () => {
  test("classifies evidence gathering as research", () => {
    for (const toolName of [
      "web_search",
      "boe_get_law",
      "fetch_url",
      "read_document",
      "read_content_across_matters",
      "list_templates",
      "describe_template",
      "discover_tools",
      "load-skill",
      "read-skill-resource",
      "mcp__salvia__search_decisions",
      "mcp__salvia__get_decision",
    ]) {
      expect(getChatToolActivityCategory(toolName)).toBe("research");
    }
  });

  test("classifies artifact work apart from mutations", () => {
    for (const toolName of [
      "suggest_changes",
      "fill_template",
      "mcp__documents__draft_agreement",
    ]) {
      expect(getChatToolActivityCategory(toolName)).toBe("artifact");
    }

    expect(getChatToolActivityCategory("save_matter")).toBe("mutation");
  });

  test("keeps a retired tool's category instead of the unknown fallback", () => {
    expect(getChatToolActivityCategory("save_template")).toBe("mutation");
    expect(getChatToolActivityCategory("edit_workspace_document")).toBe(
      "artifact",
    );
    expect(getChatToolActivityCategory("compare_versions")).toBe("research");
  });

  test("classifies tools awaiting a person as user input", () => {
    expect(getChatToolActivityCategory("ask-user")).toBe("user-input");
    expect(getChatToolActivityCategory("create-document")).toBe("user-input");
  });
});

describe("process summary", () => {
  test("counts landed work by kind and leaves out failures, waits and reasoning", () => {
    const parts = [
      { type: "thinking" as const, content: "Check clause 11." },
      {
        type: "tool-call" as const,
        id: "read",
        name: "read_document" as const,
        arguments: "{}",
        input: {},
        state: "complete" as const,
        output: { text: "11.3 Aggregate liability" },
      },
      {
        type: "tool-call" as const,
        id: "read-failed",
        name: "read_section" as const,
        arguments: "{}",
        input: {},
        state: "complete" as const,
        output: { error: "Renumbered" },
      },
      {
        type: "tool-call" as const,
        id: "still-running",
        name: "web_search" as const,
        arguments: "{}",
        input: {},
        state: "input-complete" as const,
      },
      {
        type: "tool-call" as const,
        id: "edit",
        name: "suggest_changes" as const,
        arguments: "{}",
        input: {},
        state: "complete" as const,
        output: { success: true },
      },
      {
        type: "tool-call" as const,
        id: "ask",
        name: "ask-user" as const,
        arguments: "{}",
        input: {},
        state: "complete" as const,
        output: { answers: [] },
      },
    ] satisfies ChatMessage["parts"];

    expect(countProcessWork(projectParts(parts))).toEqual(
      new Map([
        ["research", 1],
        ["artifact", 1],
      ]),
    );
  });
});

describe("thread activity", () => {
  test("uses only successful research as the synthesis boundary", () => {
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
      parts: [
        { type: "text" as const, content: "I will check." },
        {
          type: "tool-call" as const,
          id: "failed-search",
          name: "mcp__registry__lookup_company" as const,
          arguments: "{}",
          input: {},
          state: "complete" as const,
          output: { error: "Unavailable" },
        },
        {
          type: "tool-call" as const,
          id: "successful-search",
          name: "web_search" as const,
          arguments: "{}",
          input: {},
          state: "complete" as const,
          output: {
            jurisdiction: "global" as const,
            provider: "tavily" as const,
            query: "company registry",
            results: [],
          },
        },
      ],
    } satisfies ChatMessage;

    expect(getLatestCompletedResearchPartIndex([message])).toBe(2);
    expect(
      getLatestCompletedResearchPartIndex([
        { ...message, parts: message.parts.slice(0, 2) },
      ]),
    ).toBeNull();

    expect(
      getLatestCompletedResearchPartIndex([
        {
          ...message,
          parts: [
            { type: "text" as const, content: "I will check." },
            {
              type: "tool-call" as const,
              id: "failed-mcp-search",
              name: "mcp__registry__lookup_company" as const,
              arguments: "{}",
              input: {},
              state: "complete" as const,
              output: { content: [], isError: true },
            },
          ],
        },
      ]),
    ).toBeNull();
  });

  test("shows solving only between completed research and visible output", () => {
    expect(
      resolveChatActivityIndicatorState({
        hasCompletedResearch: false,
        hasRunningTool: false,
        hasVisibleResponse: false,
        hasVisibleContent: false,
      }),
    ).toBe("working");
    expect(
      resolveChatActivityIndicatorState({
        hasCompletedResearch: true,
        hasRunningTool: false,
        hasVisibleResponse: false,
        hasVisibleContent: true,
      }),
    ).toBe("solving");
    expect(
      resolveChatActivityIndicatorState({
        hasCompletedResearch: true,
        hasRunningTool: true,
        hasVisibleResponse: false,
        hasVisibleContent: true,
      }),
    ).toBeNull();
    expect(
      resolveChatActivityIndicatorState({
        hasCompletedResearch: true,
        hasRunningTool: false,
        hasVisibleResponse: true,
        hasVisibleContent: true,
      }),
    ).toBeNull();
  });
});

describe("tool names a model or a newer server sends", () => {
  test("an inherited object name is categorized as the unknown tool it is", () => {
    const unknown = getChatToolActivityCategory("no_such_tool");
    for (const name of [
      ...Object.getOwnPropertyNames(Object.prototype),
      "__proto__",
    ]) {
      expect(getChatToolActivityCategory(name)).toBe(unknown);
    }
  });
});
