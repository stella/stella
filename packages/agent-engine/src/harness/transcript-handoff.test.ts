import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { buildTurnPrompt } from "./transcript-handoff";

const user = (content: string): ModelMessage => ({ role: "user", content });

const prompt = (
  transcript: readonly ModelMessage[],
  mode: "resumed" | "standalone",
) => {
  const built = buildTurnPrompt({ transcript, mode });
  if (Result.isError(built)) {
    throw built.error;
  }
  return built.value;
};

describe("turn prompt from the portable transcript", () => {
  const transcript: ModelMessage[] = [
    user("Summarise the lease."),
    {
      role: "assistant",
      content: "The lease runs five years.",
      thinking: [{ content: "private chain of thought" }],
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: {
            name: "mcp__stella__read_document",
            arguments: '{"id":"doc-1"}',
          },
        },
      ],
    },
    { role: "tool", toolCallId: "c1", content: '{"title":"Lease"}' },
    {
      role: "user",
      content: [
        { type: "text", content: "And the notice period?" },
        {
          type: "image",
          source: { type: "url", value: "https://example.test/scan.png" },
        },
      ],
    },
  ];

  test("a resumed session gets only the new user message", () => {
    expect(prompt(transcript, "resumed")).toBe(
      "And the notice period?\n[image attachment not carried over]",
    );
  });

  test("a standalone session carries the history, without provider reasoning", () => {
    const text = prompt(transcript, "standalone");
    expect(text).toContain("User: Summarise the lease.");
    expect(text).toContain("The lease runs five years.");
    expect(text).toContain('[tool mcp__stella__read_document {"id":"doc-1"}]');
    expect(text).toContain('[tool result {"title":"Lease"}]');
    expect(text).not.toContain("private chain of thought");
    expect(text).toEndWith(
      "Current request:\nAnd the notice period?\n[image attachment not carried over]",
    );
  });

  test("a transcript that does not end with user text is refused", () => {
    const refused: ModelMessage[][] = [
      [],
      [{ role: "assistant", content: "hi" }],
      [user("   ")],
      [{ role: "user", content: null }],
    ];
    for (const bad of refused) {
      const built = buildTurnPrompt({ transcript: bad, mode: "standalone" });
      expect(Result.isError(built) && built.error.reason).toBe(
        "invalid_transcript",
      );
    }
  });

  test("history stays within budget, keeps the newest turn and the request", () => {
    assertProperty(
      "history stays within budget, keeps the newest turn and the request",
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 30_000 }), {
          minLength: 1,
          maxLength: 30,
        }),
        (texts) => {
          const history = texts.map((text, index): ModelMessage => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `turn ${index}: ${text}`,
          }));
          const request = "Final question?";
          const text = prompt([...history, user(request)], "standalone");
          expect(new TextEncoder().encode(text).byteLength).toBeLessThan(
            64 * 1024 + 256,
          );
          expect(text).toEndWith(`Current request:\n${request}`);
          expect(text).toContain(`turn ${texts.length - 1}: `);
        },
      ),
      { numRuns: 40 },
    );
  });
});
