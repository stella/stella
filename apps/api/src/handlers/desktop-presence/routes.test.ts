import { expect, test } from "bun:test";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { RouteEntry } from "@/api/http/route";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

import { createDesktopPresenceReportEndpoint } from "./report";
import { desktopPresenceRoute } from "./routes";

const report = {
  desktopId: "11111111-1111-4111-8111-111111111111",
  version: "0.9.48",
  protocol: 1,
};

const serve = (table: readonly RouteEntry[]) =>
  serveForTest(createHttpApp({ routes: table, middleware: [errorBoundary] }));

const serveReport = () =>
  serve(
    routes({
      "/v1/desktop/presence": { POST: createDesktopPresenceReportEndpoint() },
    }),
  );

test("desktop presence reports require the desktop account credential", async () => {
  await using server = serveReport();
  for (const authorization of [undefined, "Bearer unrelated-credential"]) {
    const response = await server.fetch(
      new Request("http://localhost/v1/desktop/presence", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(report),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: "Reconnect desktop to your account",
    });
  }
});

test("reports reject client time and ownership fields at the contract boundary", async () => {
  await using server = serveReport();
  for (const extra of [
    { lastSeenAt: "2030-01-01T00:00:00.000Z" },
    { userId: "other" },
    { organizationId: "other" },
  ]) {
    const response = await server.fetch(
      new Request("http://localhost/v1/desktop/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...report, ...extra }),
      }),
    );
    expect(response.status).toBe(422);
  }
});

test("presence reads require a signed-in browser account", async () => {
  await using server = serve(desktopPresenceRoute);
  const response = await server.fetch(
    new Request("http://localhost/v1/desktop/presence"),
  );
  expect(response.status).toBe(401);
});
