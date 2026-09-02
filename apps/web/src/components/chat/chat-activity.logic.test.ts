import { describe, expect, test } from "bun:test";

import {
  getChatToolActivityCategory,
  getChatToolActivityState,
  getLatestCompletedResearchPartIndex,
  resolveChatActivityIndicatorState,
} from "@/components/chat/chat-activity.logic";
import type { ChatMessage } from "@/components/chat/chat-ui-tools";

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
      expect(getChatToolActivityState(toolName)).toBe("searching");
    }
  });

  test("uses shaping only for artifact work", () => {
    for (const toolName of [
      "suggest_changes",
      "fill_template",
      "mcp__documents__draft_agreement",
    ]) {
      expect(getChatToolActivityCategory(toolName)).toBe("artifact");
      expect(getChatToolActivityState(toolName)).toBe("shaping");
    }

    expect(getChatToolActivityCategory("save_matter")).toBe("mutation");
    expect(getChatToolActivityState("save_matter")).toBe("working");
  });

  test("does not animate tools awaiting user input", () => {
    expect(getChatToolActivityCategory("ask-user")).toBe("user-input");
    expect(getChatToolActivityState("ask-user")).toBeNull();
    expect(getChatToolActivityState("create-document")).toBeNull();
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
          state: "complete" as const,
          output: { error: "Unavailable" },
        },
        {
          type: "tool-call" as const,
          id: "successful-search",
          name: "web_search" as const,
          arguments: "{}",
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
