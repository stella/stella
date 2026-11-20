import { describe, expect, test } from "bun:test";

import { CHAT_LOCAL_RUN_QUESTION_TOOL } from "./chat-local-run-question";
import { CHAT_STEP_LEDGER_KEY, type ChatStepLedger } from "./chat-step-ledger";
import {
  CHAT_TOOL_LABELS,
  chatToolLabel,
  getChatToolActivityCategory,
  groupProcessParts,
  isAnswerCardChatToolName,
  isKnownChatToolName,
  isProcessPart,
  isUserInputChatToolName,
  isVisibleProcessStep,
  summarizeProcessRun,
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
});

const SUCCEEDED = { success: true } as const;

const codeStep = (
  calls: readonly { tool: string; outcome: "ok" | "error" }[],
  output: Record<string, unknown> = SUCCEEDED,
): ChatActivityPart => ({
  type: "tool-call",
  name: "execute_typescript",
  state: "complete",
  input: { typescriptCode: "return 1;" },
  output: {
    ...output,
    [CHAT_STEP_LEDGER_KEY]: {
      calls: calls.map(({ tool, outcome }) => ({
        tool,
        queries: [],
        filters: [],
        outcome,
        found: [],
        foundOmitted: 0,
      })),
      callsOmitted: 0,
    } satisfies ChatStepLedger,
  },
});

const summary = (parts: readonly ChatActivityPart[], stepCount = 9) =>
  summarizeProcessRun(parts, { stepCount }).map(
    ({ phrase, count }) => `${phrase}:${String(count)}`,
  );

describe("a settled run's summary", () => {
  test("names legal research from the ledger, with every lookup that went through", () => {
    expect(
      summary([
        call("discover_tools", "complete", { tools: [] }),
        codeStep([{ tool: "search_case_law", outcome: "ok" }]),
        codeStep([
          { tool: "search_legislation", outcome: "ok" },
          { tool: "read_statute_provisions", outcome: "ok" },
          { tool: "search_case_law", outcome: "error" },
        ]),
      ]),
    ).toEqual(["searchedLegislationAndCaseLaw:1", "lookups:3"]);
  });

  test("keeps a ledger's reads when its script failed afterwards", () => {
    expect(
      summary([
        codeStep(
          [
            { tool: "search_case_law", outcome: "ok" },
            { tool: "search_case_law", outcome: "error" },
          ],
          {
            success: false,
            error: { message: "Court filter matched no court" },
          },
        ),
      ]),
    ).toEqual(["searchedCaseLaw:1"]);
  });

  test("reads a step stored before ledgers from its script, only when it succeeded", () => {
    const legacy = (output: unknown): ChatActivityPart => ({
      type: "tool-call",
      name: "execute_typescript",
      state: "complete",
      input: {
        typescriptCode:
          'await external_search_legislation({ query: "o. s. ř." }); await external_read_statute({ eli: "x" });',
      },
      output,
    });
    expect(summary([legacy({ success: true })])).toEqual([
      "searchedLegislation:1",
      "lookups:2",
    ]);
    expect(summary([legacy({ success: false })], 1)).toEqual(["steps:1"]);
  });

  test("names matter work, the open document, the web and registers in a fixed order, at most two", () => {
    expect(
      summary([
        codeStep([
          { tool: "list_matters", outcome: "ok" },
          { tool: "read_document", outcome: "ok" },
        ]),
        call("web_search", "complete", { results: [] }),
      ]),
    ).toEqual(["readDocuments:1", "searchedMatters:1", "lookups:3"]);
    expect(
      summary([
        call("read_document", "complete", { text: "11.3" }),
        call("find_text", "complete", { matches: [] }),
      ]),
    ).toEqual(["readDocument:1", "lookups:2"]);
    expect(
      summary([call("business_registry_lookup", "complete", { company: {} })]),
    ).toEqual(["checkedRegisters:1"]);
  });

  test("counts reads with no area of their own as sources", () => {
    expect(
      summary([
        call("mcp__registry__lookup_company", "complete", { ok: true }),
        call("list_templates", "complete", { templates: [] }),
      ]),
    ).toEqual(["sourcesChecked:2"]);
  });

  test("adds edits and saves, and leaves out failures, waits and running calls", () => {
    expect(
      summary([
        { type: "thinking", content: "Which register?" },
        call("read_document", "complete", { text: "11.3" }),
        call("read_section", "complete", { error: "Renumbered" }),
        call("web_search", "input-complete"),
        call("suggest_changes", "complete", { success: true }),
        call("save_task", "complete", { id: "t" }),
        call("ask-user", "complete", { answers: [] }),
      ]),
    ).toEqual(["readDocument:1", "documentEdits:1", "changesSaved:1"]);
  });

  test("falls back to the step count when the run read and changed nothing", () => {
    expect(
      summary(
        [
          { type: "thinking", content: "Plan" },
          call("load-skill", "complete", { name: "nda" }),
          call("command_execution", "complete", { exitCode: 0 }),
          codeStep([]),
        ],
        3,
      ),
    ).toEqual(["steps:3"]);
  });
});
