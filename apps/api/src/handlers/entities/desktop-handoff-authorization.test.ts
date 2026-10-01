import { expect, test } from "bun:test";
import Elysia from "elysia";

import { desktopEditSessionsRoute } from "@/api/handlers/entities/desktop-edit-sessions-route";
import { pdfSigningSessionsRoute } from "@/api/handlers/entities/pdf-signing-sessions-route";

const HANDOFF_TOKEN = "ab".repeat(32);

test("document handoffs require an authenticated desktop account", async () => {
  const app = new Elysia()
    .use(desktopEditSessionsRoute)
    .use(pdfSigningSessionsRoute);

  for (const [path, body] of [
    ["/desktop-edit-handoffs/redeem", { handoffToken: HANDOFF_TOKEN }],
    ["/v1/pdf-signing-handoffs/redeem", { handoffToken: HANDOFF_TOKEN }],
    [
      "/desktop-edit-handoffs/11111111-1111-4111-8111-111111111111/opened",
      {
        handoffToken: HANDOFF_TOKEN,
        sessionId: "22222222-2222-4222-8222-222222222222",
      },
    ],
  ] as const) {
    const response = await app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect([path, response.status]).toEqual([path, 401]);
  }
});
