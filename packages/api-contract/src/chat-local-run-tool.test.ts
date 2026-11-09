import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  CHAT_LOCAL_RUN_TOOL_LIMITS,
  CHAT_LOCAL_RUN_TOOL_NAMES,
  chatLocalRunShownText,
  parseChatLocalRunToolCall,
} from "./chat-local-run-tool";

const text = fc.string({ unit: "binary", maxLength: 700 });

describe("what a local run's native step shows", () => {
  test("shown text is one line within its limit, and showing it again changes nothing", async () => {
    await assertProperty(
      "shown text is bounded, single-line and idempotent",
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

  test("a call keeps only its schema's fields, and parsing what it kept gives the same call", async () => {
    const extra = fc.dictionary(
      fc.constantFrom("output", "content", "diff", "old_string", "prompt"),
      fc.string(),
    );
    const calls = fc.oneof(
      fc.record({
        name: fc.constant(CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution),
        input: fc.record({ command: text }),
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
            fc.record({ kind: fc.constant("fetch"), url: text }),
            fc.record({
              kind: fc.constant("plan"),
              items: fc.array(text, { maxLength: 80 }),
            }),
          ),
        }),
      }),
    );
    await assertProperty(
      "parsed calls drop extra fields and are stable",
      fc.property(calls, extra, (call, added) => {
        const parsed = parseChatLocalRunToolCall(call.name, {
          ...call.input,
          ...added,
        });
        if (parsed === null) {
          throw new Error("a well-formed call did not parse");
        }
        for (const key of Object.keys(added)) {
          expect(Object.keys(parsed.input)).not.toContain(key);
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
    expect(
      parseChatLocalRunToolCall(CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution, {
        output: "Private text",
      }),
    ).toBeNull();
  });
});
