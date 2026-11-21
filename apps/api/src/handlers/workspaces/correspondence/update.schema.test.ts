import { afterAll, describe, expect, test } from "bun:test";

import { CORRESPONDENCE_HANDLING_STATES } from "@stll/api-contract/correspondence";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

import updateCorrespondence from "./update";

// The route's own body schema, decoded by the real HTTP core; the endpoint
// echoes what the handler would receive.
const server = serveForTest(
  createHttpApp({
    middleware: [errorBoundary],
    routes: routes({
      "/correspondence": {
        PATCH: defineEndpoint.public(
          { body: updateCorrespondence.config.body },
          ({ body }) => body,
        ),
      },
    }),
  }),
);
afterAll(async () => {
  await server.stop();
});

describe("correspondence handling HTTP schema", () => {
  test("assignment-only requests leave handling state absent", async () => {
    const response = await server.fetch(
      new Request("http://localhost/correspondence", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assigneeId: null }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ assigneeId: null });
  });

  test("every handling state round-trips without adding an assignment", async () => {
    for (const handlingState of CORRESPONDENCE_HANDLING_STATES) {
      const body = { handlingState };
      const response = await server.fetch(
        new Request("http://localhost/correspondence", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(body);
    }
  });
});
