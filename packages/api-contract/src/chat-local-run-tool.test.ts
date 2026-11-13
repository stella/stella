import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH } from "./chat-local-run-step-output";
import {
  CHAT_LOCAL_RUN_NEEDS_MEMBER,
  CHAT_LOCAL_RUN_TOOL_LIMITS,
  CHAT_LOCAL_RUN_TOOL_NAMES,
  CHAT_LOCAL_RUN_TOOL_STATUSES,
  chatLocalRunApprovalMessage,
  chatLocalRunShownText,
  parseChatLocalRunToolCall,
  shownChatLocalRunToolResult,
} from "./chat-local-run-tool";

const text = fc.string({ unit: "binary", maxLength: 700 });

describe("what a local run's native step shows", () => {
  test("shown text is one line within its limit, and showing it again changes nothing", () => {
    assertProperty(
      "shown text is one line within its limit, and showing it again changes nothing",
      fc.property(text, fc.integer({ min: 2, max: 600 }), (raw, limit) => {
        const shown = chatLocalRunShownText(raw, limit);
        expect(shown.length).toBeLessThanOrEqual(limit);
        expect(shown).not.toMatch(/[\n\r\u2028\u2029]/u);
        expect(chatLocalRunShownText(shown, limit)).toBe(shown);
        // Nothing is shown that was not in the line it came from.
        const kept = shown.endsWith("…") ? shown.slice(0, -1) : shown;
        expect(raw.trimStart().startsWith(kept)).toBe(true);
      }),
    );
  });

  test("a heredoc shows the line that runs it, never the text it writes", () => {
    const call = parseChatLocalRunToolCall(
      CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution,
      {
        command: "cat > notes.md <<'EOF'\nPrivate settlement terms\nEOF",
      },
    );
    expect(call?.input).toEqual({ command: "cat > notes.md <<'EOF'…" });
  });

  test("a cut never leaves half of a character", () => {
    const shown = chatLocalRunShownText(`${"a".repeat(8)}😀😀`, 10);
    expect(shown).toBe(`${"a".repeat(8)}…`);
  });

  test("a call keeps only its schema's fields, and parsing what it kept gives the same call", () => {
    const extra = fc.dictionary(
      fc.constantFrom(
        "output",
        "content",
        "diff",
        "old_string",
        "prompt",
        "report",
        "messages",
      ),
      fc.string(),
    );
    // The subagent step a step ran in: none, one that names a step, and ids
    // that name none (empty, or longer than a chat call id).
    const parent = fc.option(
      fc.oneof(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.constant(""),
        fc.string({
          minLength: CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH + 1,
          maxLength: CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH + 40,
        }),
      ),
      { nil: undefined },
    );
    const calls = fc.oneof(
      fc.record({
        name: fc.constant(CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution),
        input: fc.record({ command: text }),
      }),
      fc.record({
        name: fc.constant(CHAT_LOCAL_RUN_TOOL_NAMES.webSearch),
        input: fc.record({ query: text }),
      }),
      fc.record({
        name: fc.constant(CHAT_LOCAL_RUN_TOOL_NAMES.unsupportedItem),
        input: fc.record({ itemType: text }),
      }),
      fc.record({
        name: fc.constant(CHAT_LOCAL_RUN_TOOL_NAMES.fileChange),
        input: fc.record({
          changes: fc.array(
            fc.record({
              path: text,
              kind: fc.constantFrom("add", "delete", "update"),
            }),
            { maxLength: 80 },
          ),
        }),
      }),
      fc.record({
        name: fc.constant(CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool),
        input: fc.record({
          tool: text,
          detail: fc.oneof(
            fc.record({ kind: fc.constant("read"), path: text }),
            fc.record({ kind: fc.constant("image"), path: text }),
            fc.record({ kind: fc.constant("search"), pattern: text }),
            fc.record({ kind: fc.constant("fetch"), url: text }),
            fc.record(
              {
                kind: fc.constant("subagent"),
                description: text,
                agentType: text,
              },
              { requiredKeys: ["kind", "description"] },
            ),
            fc.record({
              kind: fc.constant("plan"),
              items: fc.array(text, { maxLength: 80 }),
            }),
          ),
        }),
      }),
    );
    assertProperty(
      "a call keeps only its schema's fields, and parsing what it kept gives the same call",
      fc.property(calls, extra, parent, (call, added, parentCallId) => {
        const parsed = parseChatLocalRunToolCall(call.name, {
          ...call.input,
          ...added,
          ...(parentCallId === undefined ? {} : { parentCallId }),
        });
        if (parsed === null) {
          throw new Error("a well-formed call did not parse");
        }
        for (const key of Object.keys(added)) {
          expect(Object.keys(parsed.input)).not.toContain(key);
        }
        // Every kind of step names the subagent step it ran in, whole or
        // not at all, and loses nothing of its own to an id that names none.
        const namesStep =
          parentCallId !== undefined &&
          parentCallId !== "" &&
          parentCallId.length <= CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH;
        expect(parsed.input.parentCallId).toBe(
          namesStep ? parentCallId : undefined,
        );
        expect(Object.keys(parsed.input).toSorted()).toEqual(
          [
            ...Object.keys(call.input),
            ...(namesStep ? ["parentCallId"] : []),
          ].toSorted(),
        );
        if (
          parsed.name === CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool &&
          parsed.input.detail?.kind === "subagent"
        ) {
          expect(parsed.input.detail.description.length).toBeLessThanOrEqual(
            CHAT_LOCAL_RUN_TOOL_LIMITS.description,
          );
          expect(
            (parsed.input.detail.agentType ?? "").length,
          ).toBeLessThanOrEqual(CHAT_LOCAL_RUN_TOOL_LIMITS.name);
        }
        if (
          parsed.name === CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool &&
          parsed.input.detail?.kind === "image"
        ) {
          expect(parsed.input.detail.path.length).toBeLessThanOrEqual(
            CHAT_LOCAL_RUN_TOOL_LIMITS.path,
          );
        }
        expect(parseChatLocalRunToolCall(parsed.name, parsed.input)).toEqual(
          parsed,
        );
        if (parsed.name === CHAT_LOCAL_RUN_TOOL_NAMES.fileChange) {
          expect(parsed.input.changes.length).toBeLessThanOrEqual(
            CHAT_LOCAL_RUN_TOOL_LIMITS.files,
          );
        }
        if (parsed.name === CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution) {
          expect(parsed.input.command.length).toBeLessThanOrEqual(
            CHAT_LOCAL_RUN_TOOL_LIMITS.command,
          );
        }
      }),
    );
  });

  test("a native tool whose detail does not parse keeps its name, and anything else keeps nothing", () => {
    expect(
      parseChatLocalRunToolCall(CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool, {
        tool: "Read",
        detail: { kind: "read", path: 42, content: "Private text" },
      }),
    ).toEqual({
      name: CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool,
      input: { tool: "Read" },
    });
    // A subagent's step keeps the few words of its task, never its prompt;
    // one whose detail does not parse still names the subagent it ran in.
    expect(
      parseChatLocalRunToolCall(CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool, {
        tool: "Agent",
        detail: {
          kind: "subagent",
          description: "Check the lease",
          agentType: "Explore",
          prompt: "Private text",
        },
      })?.input,
    ).toEqual({
      tool: "Agent",
      detail: {
        kind: "subagent",
        description: "Check the lease",
        agentType: "Explore",
      },
    });
    expect(
      parseChatLocalRunToolCall(CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool, {
        tool: "Read",
        detail: { kind: "read", path: 42 },
        parentCallId: "toolu_agent",
      })?.input,
    ).toEqual({ tool: "Read", parentCallId: "toolu_agent" });
    expect(
      parseChatLocalRunToolCall(CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution, {
        output: "Private text",
      }),
    ).toBeNull();
  });

  test("a native step's result keeps how it ended and never what it produced", () => {
    assertProperty(
      "a native step's result keeps how it ended and never what it produced",
      fc.property(
        fc.constantFrom(...Object.values(CHAT_LOCAL_RUN_TOOL_NAMES)),
        fc.constantFrom(...CHAT_LOCAL_RUN_TOOL_STATUSES),
        fc.option(fc.integer({ min: -255, max: 255 }), { nil: undefined }),
        text,
        fc.boolean(),
        (name, status, exitCode, produced, failed) => {
          const reported = JSON.stringify({
            status,
            ...(exitCode === undefined ? {} : { exit_code: exitCode }),
            changes: [{ path: "a.md", kind: "update", diff: produced }],
            aggregated_output: produced,
            content: produced,
          });
          const shown = shownChatLocalRunToolResult(name, reported, failed);
          const kept: unknown = JSON.parse(shown);
          expect(kept).toMatchObject({ status });
          expect(Object.keys(kept ?? {})).not.toContain("aggregated_output");
          expect(Object.keys(kept ?? {})).not.toContain("content");
          expect(shown).not.toContain("diff");
          expect(shownChatLocalRunToolResult(name, shown, failed)).toBe(shown);
        },
      ),
    );
  });

  test("a result that is not the step's keeps only whether it failed", () => {
    for (const content of ["1→Private settlement terms", '{"status":"done"}']) {
      expect(
        shownChatLocalRunToolResult(
          CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool,
          content,
          true,
        ),
      ).toBe(JSON.stringify({ status: "failed" }));
    }
    expect(
      shownChatLocalRunToolResult(
        CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution,
        JSON.stringify({ aggregated_output: "Private", status: "completed" }),
        false,
      ),
    ).toBe(JSON.stringify({ status: "completed" }));
  });

  test("an approval names a command by its shown line, and anything else by a shown reason or its tool", () => {
    expect(
      chatLocalRunApprovalMessage({
        toolName: CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution,
        input: { command: "cat > notes.md <<'EOF'\nPrivate terms\nEOF" },
        reason: "Private terms",
      }),
    ).toBe("cat > notes.md <<'EOF'…");
    expect(
      chatLocalRunApprovalMessage({
        toolName: CHAT_LOCAL_RUN_TOOL_NAMES.fileChange,
        input: { changes: [] },
        reason: "Edits notes\nPrivate terms",
      }),
    ).toBe("Edits notes…");
    expect(
      chatLocalRunApprovalMessage({
        toolName: "mcp__docs__read",
        input: { id: "1" },
        reason: null,
      }),
    ).toBe("Approval required to run mcp__docs__read");
  });
});

describe("a browser step on the member's computer", () => {
  test("keeps the kind of step and the opened address, never the page", () => {
    expect(
      parseChatLocalRunToolCall(CHAT_LOCAL_RUN_TOOL_NAMES.browser, {
        action: "open",
        url: "https://fixture-library.test/search",
        snapshot: { text: "Private page text" },
      }),
    ).toEqual({
      name: CHAT_LOCAL_RUN_TOOL_NAMES.browser,
      input: { action: "open", url: "https://fixture-library.test/search" },
    });
    expect(
      parseChatLocalRunToolCall(CHAT_LOCAL_RUN_TOOL_NAMES.browser, {
        action: "type",
        ref: "e:0:1.2",
        text: "Private query",
      }),
    ).toEqual({
      name: CHAT_LOCAL_RUN_TOOL_NAMES.browser,
      input: { action: "type" },
    });
    expect(
      parseChatLocalRunToolCall(CHAT_LOCAL_RUN_TOOL_NAMES.browser, {
        action: "click",
        url: "https://fixture-library.test/private",
      }),
    ).toEqual({
      name: CHAT_LOCAL_RUN_TOOL_NAMES.browser,
      input: { action: "click" },
    });
    expect(
      parseChatLocalRunToolCall(CHAT_LOCAL_RUN_TOOL_NAMES.browser, {
        action: "evaluate",
      }),
    ).toBeNull();
  });

  test("a sign-in the member completes is kept as its own status", () => {
    const content = JSON.stringify({
      status: CHAT_LOCAL_RUN_NEEDS_MEMBER,
      message: "This page asks for a sign-in.",
      page: { text: "Private page text" },
    });
    expect(
      shownChatLocalRunToolResult(
        CHAT_LOCAL_RUN_TOOL_NAMES.browser,
        content,
        true,
      ),
    ).toBe(JSON.stringify({ status: CHAT_LOCAL_RUN_NEEDS_MEMBER }));
    expect(
      shownChatLocalRunToolResult(
        CHAT_LOCAL_RUN_TOOL_NAMES.browser,
        JSON.stringify({ text: "Private page text", title: "Library" }),
        false,
      ),
    ).toBe(JSON.stringify({ status: "completed" }));
  });
});
