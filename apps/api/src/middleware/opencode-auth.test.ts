import { describe, expect, test } from "bun:test";

import { opencodeAuthMiddleware } from "./opencode-auth";

describe("opencodeAuthMiddleware", () => {
  test("rejects request without Bearer token", async () => {
    const req = new Request("http://localhost", { method: "GET" });
    const res = await opencodeAuthMiddleware(
      req,
      async () => new Response("ok"),
    );
    expect(res.status).toBe(401);
  });
});
