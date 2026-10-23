import { describe, expect, test } from "bun:test";

import { listSignalsQuerySchema } from "@/api/handlers/signals/schema";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

describe("listSignalsQuerySchema", () => {
  test("does not invent filters when optional query fields are absent", async () => {
    let received: unknown;
    await using server = serveForTest(
      createHttpApp({
        middleware: [errorBoundary],
        routes: routes({
          "/signals": {
            GET: defineEndpoint.public(
              { query: listSignalsQuerySchema },
              ({ query }) => {
                received = query;
                return "ok";
              },
            ),
          },
        }),
      }),
    );

    const response = await server.fetch(
      new Request("https://example.test/signals"),
    );

    expect(response.status).toBe(200);
    expect(received).toEqual({});
  });
});
