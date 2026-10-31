import { expect, test } from "bun:test";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";

import { apiPipeline } from "@/api/api-pipeline";
import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { serveForTest } from "@/api/tests/helpers/test-server";

test("browser create requests admit their composed mutation headers", async () => {
  await using server = serveForTest(
    createHttpApp({ middleware: apiPipeline, routes: routes({}) }),
  );
  const origin = new URL(env.FRONTEND_URL).origin;
  const requestedHeaders = [
    "Content-Type",
    "Idempotency-Key",
    CAPABILITY_REQUEST_HEADER,
  ];
  for (const path of [
    "/v1/lists/matter",
    "/v1/skills/from-blueprint",
    "/v1/client-invoices/client",
  ]) {
    const response = await server.fetch(
      new Request(`http://localhost${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": requestedHeaders
            .join(", ")
            .toLowerCase(),
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    const allowedHeaders = response.headers
      .get("Access-Control-Allow-Headers")
      ?.toLowerCase()
      .split(",")
      .map((name) => name.trim());
    for (const header of requestedHeaders) {
      expect(allowedHeaders).toContain(header.toLowerCase());
    }
  }
});
