import { describe, expect, test } from "bun:test";

import { revisionResult } from "@/api/handlers/chat/messages/revisions/accept";

describe("chat revision response", () => {
  test("a stale base revision returns a conflict with a reload instruction", () => {
    const result = revisionResult({ type: "stale" });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) {
      throw new TypeError("Expected a stale revision conflict");
    }
    expect(result.error.status).toBe(409);
    expect(result.error.message).toContain("reload the message");
  });
});
