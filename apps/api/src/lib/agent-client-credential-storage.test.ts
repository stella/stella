import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { runAgentClientCredentialBatch } from "@/api/lib/agent-client-credential-storage";

let priorStorageSetting = false;
beforeEach(() => {
  priorStorageSetting = env.AGENT_CLIENT_STORAGE_V1_ENABLED;
  env.AGENT_CLIENT_STORAGE_V1_ENABLED = true;
});
afterEach(() => {
  env.AGENT_CLIENT_STORAGE_V1_ENABLED = priorStorageSetting;
});

describe("agent client storage run boundaries", () => {
  const unusedDatabase = {
    transaction: async () => {
      throw new Error("database should remain untouched");
    },
  };

  test("does not access storage before the write setting is enabled", async () => {
    env.AGENT_CLIENT_STORAGE_V1_ENABLED = false;
    expect(
      await runAgentClientCredentialBatch({
        db: unusedDatabase,
        signal: new AbortController().signal,
        deadline: Date.now() + 60_000,
      }),
    ).toBe(0);
  });

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
