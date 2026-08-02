import { describe, expect, test } from "bun:test";

import {
  getChatToolActivityCategory,
  getChatToolActivityState,
  resolveChatActivityIndicatorState,
} from "@/components/chat/chat-activity.logic";

describe("chat tool activity", () => {
  test("classifies evidence gathering as research", () => {
    for (const toolName of [
      "web_search",
      "boe_get_law",
      "fetch_url",
      "read_document",
      "read_content_across_matters",
      "mcp__salvia__search_decisions",
      "mcp__salvia__get_decision",
    ]) {
      expect(getChatToolActivityCategory(toolName)).toBe("research");
      expect(getChatToolActivityState(toolName)).toBe("searching");
    }
  });

  test("uses shaping only for artifact work", () => {
    for (const toolName of [
      "edit_workspace_document",
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
