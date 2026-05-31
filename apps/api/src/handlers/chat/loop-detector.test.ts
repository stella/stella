import type { ModelMessage } from "ai";
import { describe, expect, test } from "bun:test";

import {
  createLoopRecoveryMessage,
  detectModelLoop,
  shouldInjectLoopRecovery,
} from "./loop-detector";

const toolCallMessage = ({
  input,
  toolName = "searchMatter",
}: {
  input: unknown;
  toolName?: string | undefined;
}): ModelMessage => ({
  role: "assistant",
  content: [
    {
      type: "tool-call",
      toolCallId: Bun.randomUUIDv7(),
      toolName,
      input,
    },
  ],
});

describe("model loop detection", () => {
  test("detects five consecutive identical tool calls", () => {
    const messages = Array.from({ length: 5 }, () =>
      toolCallMessage({ input: { query: "force majeure" } }),
    );

    const detection = detectModelLoop(messages);

    expect(detection).toEqual({
      repetitionCount: 5,
      toolName: "searchMatter",
      type: "tool-call-loop",
    });
    expect(shouldInjectLoopRecovery(detection)).toBe(true);
  });

  test("treats reordered object keys as the same tool input", () => {
    const messages = [
      toolCallMessage({
        input: { filters: { jurisdiction: "CZ", type: "contract" } },
      }),
      toolCallMessage({
        input: { filters: { type: "contract", jurisdiction: "CZ" } },
      }),
      toolCallMessage({
        input: { filters: { jurisdiction: "CZ", type: "contract" } },
      }),
      toolCallMessage({
        input: { filters: { type: "contract", jurisdiction: "CZ" } },
      }),
      toolCallMessage({
        input: { filters: { jurisdiction: "CZ", type: "contract" } },
      }),
    ];

    expect(detectModelLoop(messages).type).toBe("tool-call-loop");
  });

  test("does not flag batch work with different tool inputs", () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      toolCallMessage({ input: { documentId: `doc_${index}` } }),
    );

    expect(detectModelLoop(messages)).toEqual({ type: "none" });
  });

  test("does not count repeated tool calls across separate user turns", () => {
    const messages = Array.from({ length: 6 }, () => [
      {
        role: "user" as const,
        content: "Run the same search again.",
      },
      toolCallMessage({ input: { query: "termination" } }),
    ]).flat();

    expect(detectModelLoop(messages)).toEqual({ type: "none" });
  });

  test("injects recovery periodically instead of on every repeated call", () => {
    const sixCalls = Array.from({ length: 6 }, () =>
      toolCallMessage({ input: { query: "termination" } }),
    );
    const tenCalls = Array.from({ length: 10 }, () =>
      toolCallMessage({ input: { query: "termination" } }),
    );

    expect(shouldInjectLoopRecovery(detectModelLoop(sixCalls))).toBe(false);
    expect(shouldInjectLoopRecovery(detectModelLoop(tenCalls))).toBe(true);
  });

  test("detects repeated assistant text chunks", () => {
    const repeated = "No progress was made on this exact same line. ";
    const detection = detectModelLoop([
      {
        role: "assistant",
        content: repeated.repeat(14),
      },
    ]);

    expect(detection.type).toBe("content-loop");
    expect(shouldInjectLoopRecovery(detection)).toBe(true);
  });

  test("recovery message does not echo sensitive tool arguments", () => {
    const detection = detectModelLoop(
      Array.from({ length: 5 }, () =>
        toolCallMessage({
          input: { party: "Jan Novak", query: "confidential dispute" },
        }),
      ),
    );
    if (detection.type === "none") {
      throw new Error("Expected loop detection");
    }

    const recovery = createLoopRecoveryMessage(detection);

    expect(recovery.content).not.toContain("Jan Novak");
    expect(recovery.content).not.toContain("confidential dispute");
    expect(recovery.content).toContain("searchMatter");
  });
});
