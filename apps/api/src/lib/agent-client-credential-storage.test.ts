import { describe, expect, test } from "bun:test";

import { runAgentClientCredentialBatch } from "@/api/lib/agent-client-credential-storage";

describe("agent client storage run boundaries", () => {
  const unusedDatabase = {
    transaction: async () => {
      throw new Error("database should remain untouched");
    },
  };

  test("does not start a page after its run budget expires", async () => {
    expect(
      await runAgentClientCredentialBatch({
        db: unusedDatabase,
        signal: new AbortController().signal,
        deadline: 0,
      }),
    ).toBe(0);
  });

  test("does not start a page after cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("storage run cancelled");
    controller.abort(reason);
    await expect(
      runAgentClientCredentialBatch({
        db: unusedDatabase,
        signal: controller.signal,
        deadline: Date.now() + 60_000,
      }),
    ).rejects.toThrow(reason.message);
  });
});
