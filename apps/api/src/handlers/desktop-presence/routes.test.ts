import { expect, test } from "bun:test";
import Elysia from "elysia";

import { createDesktopPresenceReportEndpoint } from "./report";
import { desktopPresenceRoute } from "./routes";

const report = {
  desktopId: "11111111-1111-4111-8111-111111111111",
  version: "0.9.48",
  protocol: 1,
};

test("desktop presence reports require the desktop account credential", async () => {
  const endpoint = createDesktopPresenceReportEndpoint();
  const app = new Elysia().post("/v1/desktop/presence", endpoint.handler, {
    body: endpoint.config.body,
    response: endpoint.config.response,
  });
  for (const authorization of [undefined, "Bearer unrelated-credential"]) {
    const response = await app.handle(
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
  const endpoint = createDesktopPresenceReportEndpoint();
  const app = new Elysia().post("/v1/desktop/presence", endpoint.handler, {
    body: endpoint.config.body,
    response: endpoint.config.response,
  });
  for (const extra of [
    { lastSeenAt: "2030-01-01T00:00:00.000Z" },
    { userId: "other" },
    { organizationId: "other" },
  ]) {
    const response = await app.handle(
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
  const response = await new Elysia()
    .use(desktopPresenceRoute)
    .handle(new Request("http://localhost/v1/desktop/presence"));
  expect(response.status).toBe(401);
});
