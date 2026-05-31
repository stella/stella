import type { ModelMessage } from "ai";
import { describe, expect, test } from "bun:test";

import {
  createLoopRecoverySystemPrompt,
  detectModelLoop,
  getLoopRecoveryKey,
  shouldInjectLoopRecovery,
  shouldSurfaceFinalContentLoop,
  shouldStopLoopRecovery,
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

    expect(detection.type).toBe("tool-call-loop");
    if (detection.type === "tool-call-loop") {
      expect(detection.repetitionCount).toBe(5);
      expect(detection.signature).toHaveLength(64);
      expect(detection.toolName).toBe("searchMatter");
    }
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

  test("handles structured values that JSON.stringify cannot serialize", () => {
    const messages = Array.from({ length: 5 }, () =>
      toolCallMessage({ input: { amount: 10n } }),
    );

    const detection = detectModelLoop(messages);

    expect(detection.type).toBe("tool-call-loop");
    if (detection.type === "tool-call-loop") {
      expect(detection.repetitionCount).toBe(5);
      expect(detection.signature).toHaveLength(64);
      expect(detection.toolName).toBe("searchMatter");
    }
  });

  test("does not flag batch work with different tool inputs", () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      toolCallMessage({ input: { documentId: `doc_${index}` } }),
    );

    expect(detectModelLoop(messages)).toEqual({ type: "none" });
  });

  test("detects repeated tool calls even when the model alternates tools", () => {
    const messages = Array.from({ length: 5 }, (_, index) => [
      toolCallMessage({
        input: { documentId: `doc_${index}` },
        toolName: "readDocument",
      }),
      toolCallMessage({ input: { query: "termination" } }),
    ]).flat();

    const detection = detectModelLoop(messages);

    expect(detection.type).toBe("tool-call-loop");
    if (detection.type === "tool-call-loop") {
      expect(detection.repetitionCount).toBe(5);
      expect(detection.signature).toHaveLength(64);
      expect(detection.toolName).toBe("searchMatter");
    }
  });

  test("uses tool input identity in the internal recovery key", () => {
    const firstDetection = detectModelLoop(
      Array.from({ length: 5 }, () =>
        toolCallMessage({ input: { query: "termination" } }),
      ),
    );
    const nextDetection = detectModelLoop(
      Array.from({ length: 5 }, () =>
        toolCallMessage({ input: { query: "force majeure" } }),
      ),
    );
    if (firstDetection.type !== "tool-call-loop") {
      throw new Error("Expected first tool loop detection");
    }
    if (nextDetection.type !== "tool-call-loop") {
      throw new Error("Expected next tool loop detection");
    }

    expect(getLoopRecoveryKey(nextDetection)).not.toBe(
      getLoopRecoveryKey(firstDetection),
    );
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

  test("hard-stops persistent loops after repeated recovery attempts", () => {
    const detection = detectModelLoop(
      Array.from({ length: 15 }, () =>
        toolCallMessage({ input: { query: "termination" } }),
      ),
    );

    expect(shouldStopLoopRecovery(detection)).toBe(true);
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
    if (detection.type === "content-loop") {
      expect(detection.repetitionCount).toBeGreaterThanOrEqual(10);
      expect(detection.signature).toHaveLength(64);
    }
  });

  test("hard-stops content loops that keep repeating past recovery", () => {
    const repeated = "No progress was made on this exact same line. ";
    const detection = detectModelLoop([
      {
        role: "assistant",
        content: repeated.repeat(24),
      },
    ]);

    expect(detection.type).toBe("content-loop");
    expect(shouldStopLoopRecovery(detection)).toBe(true);
  });

  test("surfaces final content loops without treating tool loops as final text", () => {
    const contentLoop = detectModelLoop([
      {
        role: "assistant",
        content: "No progress was made on this exact same line. ".repeat(14),
      },
    ]);
    const toolLoop = detectModelLoop(
      Array.from({ length: 5 }, () =>
        toolCallMessage({ input: { query: "termination" } }),
      ),
    );

    expect(shouldSurfaceFinalContentLoop(contentLoop)).toBe(true);
    expect(shouldSurfaceFinalContentLoop(toolLoop)).toBe(false);
  });

  test("uses repeated content identity in the internal recovery key", () => {
    const firstDetection = detectModelLoop([
      {
        role: "assistant",
        content: "No progress was made on this exact same line. ".repeat(14),
      },
    ]);
    const nextDetection = detectModelLoop([
      {
        role: "assistant",
        content: "Still repeating a different exact same line. ".repeat(14),
      },
    ]);
    if (firstDetection.type !== "content-loop") {
      throw new Error("Expected first content loop detection");
    }
    if (nextDetection.type !== "content-loop") {
      throw new Error("Expected next content loop detection");
    }

    expect(getLoopRecoveryKey(nextDetection)).not.toBe(
      getLoopRecoveryKey(firstDetection),
    );
  });

  test("prefers the active content loop over stale repeated text", () => {
    const staleChunk = "Earlier repeated text ".padEnd(50, "s");
    const activeChunk = "New repeated text ".padEnd(50, "n");
    const staleDetection = detectModelLoop([
      {
        role: "assistant",
        content: staleChunk.repeat(20),
      },
    ]);
    const detection = detectModelLoop([
      {
        role: "assistant",
        content: `${staleChunk.repeat(20)}\n${activeChunk.repeat(10)}`,
      },
    ]);

    expect(staleDetection.type).toBe("content-loop");
    expect(detection.type).toBe("content-loop");
    if (staleDetection.type === "none" || detection.type === "none") {
      throw new Error("Expected content loop detection");
    }

    expect(detection.signature).not.toBe(staleDetection.signature);
    expect(detection.repetitionCount).toBe(10);
    expect(shouldInjectLoopRecovery(detection)).toBe(true);
  });

  test("keeps the same recovery key when stale repeated text has not changed", () => {
    const repeated = "No progress was made on this exact same line. ";
    const firstDetection = detectModelLoop([
      {
        role: "assistant",
        content: repeated.repeat(14),
      },
    ]);
    const nextDetection = detectModelLoop([
      {
        role: "assistant",
        content: repeated.repeat(14),
      },
      toolCallMessage({ input: { documentId: "doc_1" } }),
    ]);
    if (firstDetection.type === "none" || nextDetection.type === "none") {
      throw new Error("Expected loop detection");
    }

    expect(getLoopRecoveryKey(nextDetection)).toBe(
      getLoopRecoveryKey(firstDetection),
    );
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

    const recovery = createLoopRecoverySystemPrompt({
      baseSystem: "Base system prompt.",
      detection,
    });

    expect(recovery).not.toContain("Jan Novak");
    expect(recovery).not.toContain("confidential dispute");
    expect(recovery).toContain("Base system prompt.");
    expect(recovery).toContain("searchMatter");
  });
});
