import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { listSignalsQuerySchema } from "@/api/handlers/signals/schema";

describe("listSignalsQuerySchema", () => {
  test("does not invent filters when optional query fields are absent", async () => {
    let received: unknown;
    const app = new Elysia().get(
      "/signals",
      ({ query }) => {
        received = query;
        return "ok";
      },
      { query: listSignalsQuerySchema },
    );

    const response = await app.handle(
      new Request("https://example.test/signals"),
    );

    expect(response.status).toBe(200);
    expect(received).toEqual({});
  });
});
