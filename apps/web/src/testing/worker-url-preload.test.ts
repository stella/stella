import { describe, expect, test } from "bun:test";

import { warmupChatAnonymizeWorker } from "@/lib/anonymize/anonymize-chat-worker-client";

describe("web test preload worker-url plugin", () => {
  test("allows modules with Vite ?worker&url imports to load without per-file plugins", async () => {
    const workerModule =
      await import("@/workers/anonymize-chat-worker?worker&url");

    expect(typeof warmupChatAnonymizeWorker).toBe("function");
    expect(typeof workerModule.default).toBe("string");
    expect(workerModule.default.length).toBeGreaterThan(0);
  });
});
