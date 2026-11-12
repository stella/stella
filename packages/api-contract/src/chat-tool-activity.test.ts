import { describe, expect, test } from "bun:test";

import { CHAT_LOCAL_RUN_QUESTION_TOOL } from "./chat-local-run-question";
import {
  CHAT_TOOL_LABELS,
  chatToolLabel,
  countProcessWork,
  getChatToolActivityCategory,
  groupProcessParts,
  isAnswerCardChatToolName,
  isKnownChatToolName,
  isProcessPart,
  isUserInputChatToolName,
  isVisibleProcessStep,
  UNKNOWN_CHAT_TOOL_LABEL,
} from "./chat-tool-activity";
import type { ChatActivityPart } from "./chat-tool-activity";
import { BUILT_IN_CHAT_TOOL_POLICY_KINDS } from "./chat-tool-policy";

const call = (
  name: string,
  state: string,
  output?: unknown,
): ChatActivityPart => ({ type: "tool-call", name, state, output });

describe("step titles", () => {
  test("give code mode's plumbing a title of its own, never the unknown one", () => {
    for (const name of [
      "discover_tools",
      "execute_typescript",
      "load-skill",
      "read-skill-resource",
    ] as const) {
      expect(chatToolLabel(name)).toBe(name);
    }
  });

  test("name every registered tool", () => {
    for (const name of Object.keys(BUILT_IN_CHAT_TOOL_POLICY_KINDS)) {
      expect(isKnownChatToolName(name)).toBe(true);
      expect(chatToolLabel(name)).not.toBe(UNKNOWN_CHAT_TOOL_LABEL);
    }
  });

  test("keep a retired tool's title, sharing it with the tool that replaced it", () => {
    expect(chatToolLabel("edit_workspace_document")).toBe("suggest_changes");
    expect(chatToolLabel("read_contact")).toBe("read-contact");
    expect(chatToolLabel("update-current-skill-body")).toBe(
      chatToolLabel("create-current-skill-resource"),
    );
  });

  test("read an unknown or external tool, or an inherited key, as unknown", () => {
    for (const name of [
      "mcp__registry__lookup_company",
      "no_such_tool",
      "constructor",
      "__proto__",
    ]) {
      expect(chatToolLabel(name)).toBe(UNKNOWN_CHAT_TOOL_LABEL);
    }
  });

  test("list each title a catalogue must hold once", () => {
    expect(new Set(CHAT_TOOL_LABELS).size).toBe(CHAT_TOOL_LABELS.length);
    expect(CHAT_TOOL_LABELS).toContain(UNKNOWN_CHAT_TOOL_LABEL);
    expect(CHAT_TOOL_LABELS).toContain("execute_typescript");
  });
});

describe("kinds of work", () => {
  test("reads an external tool's kind from its verb", () => {
    expect(getChatToolActivityCategory("mcp__salvia__search_decisions")).toBe(
      "research",
    );
    expect(getChatToolActivityCategory("mcp__docs__draft_agreement")).toBe(
      "artifact",
    );
    expect(getChatToolActivityCategory("mcp__crm__update_contact")).toBe(
      "mutation",
    );
    expect(getChatToolActivityCategory("mcp__x__run")).toBe("computation");
  });

  test("a local agent's blocking question is a step of its own that waits on a person", () => {
    expect(chatToolLabel(CHAT_LOCAL_RUN_QUESTION_TOOL)).toBe(
      "request_user_input",
    );
    expect(getChatToolActivityCategory(CHAT_LOCAL_RUN_QUESTION_TOOL)).toBe(
      "user-input",
    );
    expect(isUserInputChatToolName(CHAT_LOCAL_RUN_QUESTION_TOOL)).toBe(true);
  });

  test("inherited object keys are not user-input tool names", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(isUserInputChatToolName(name)).toBe(false);
    }
  });
});

describe("runs of steps", () => {
  test("gather consecutive steps between texts, cards standing apart", () => {
    const parts: ChatActivityPart[] = [
      { type: "text", content: "Looking." },
      { type: "thinking", content: "Which register?" },
      call("execute_typescript", "complete", { success: true }),
      { type: "tool-result", content: "{}" },
      call("ask-user", "input-complete"),
      call("load-skill", "complete", {}),
      { type: "text", content: "Done." },
    ];
    expect(isAnswerCardChatToolName("ask-user")).toBe(true);
    expect(
      groupProcessParts(parts, isProcessPart).map((group) =>
        group.kind === "process"
          ? { start: group.startIndex, size: group.items.length }
          : group.item.type,
      ),
    ).toEqual([
      "text",
      { start: 1, size: 3 },
      "tool-call",
      { start: 5, size: 1 },
      "text",
    ]);
  });

  test("show reasoning with text and calls, not results or failed skill loads", () => {
    const parts = [
      { type: "thinking", content: " " },
      { type: "thinking", content: "Which register?" },
      { type: "tool-result", content: "{}" },
      call("load-skill", "error"),
      call("web_search", "complete", { results: [] }),
      call("web_search", "input-streaming"),
      call("execute_typescript", "complete", { success: false }),
    ];
    // A finished search is a source where the surface lists sources, and a
    // step where it does not.
    expect(
      parts.map((part) =>
        isVisibleProcessStep(part, { searchesShownApart: true }),
      ),
    ).toEqual([false, true, false, false, false, true, true]);
    expect(
      parts.map((part) =>
        isVisibleProcessStep(part, { searchesShownApart: false }),
      ),
    ).toEqual([false, true, false, false, true, true, true]);
  });

  test("count what landed by kind, leaving out failures, waits and running calls", () => {
    expect(
      countProcessWork([
        { type: "thinking", content: "Which register?" },
        call("read_document", "complete", { text: "11.3" }),
        call("read_section", "complete", { error: "Renumbered" }),
        call("web_search", "input-complete"),
        call("suggest_changes", "complete", { success: true }),
        call("execute_typescript", "complete", { isError: true }),
        call("ask-user", "complete", { answers: [] }),
      ]),
    ).toEqual(
      new Map([
        ["research", 1],
        ["artifact", 1],
      ]),
    );
  });
});
