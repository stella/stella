import { describe, expect, test } from "bun:test";

describe("web test preload worker-url plugin", () => {
  test("resolves Vite ?worker&url imports with a default string URL without per-file plugins", async () => {
    const workerModule =
      await import("@/workers/anonymize-chat-worker?worker&url");

    expect(typeof workerModule.default).toBe("string");
    expect(workerModule.default.length).toBeGreaterThan(0);
  });
});
