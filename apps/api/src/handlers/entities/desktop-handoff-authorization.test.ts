import { expect, test } from "bun:test";
import Elysia from "elysia";

import {
  DESKTOP_HANDOFF_PROTOCOL_HEADER,
  DESKTOP_HANDOFF_PROTOCOL_VERSION,
} from "@stll/api-contract/desktop-handoff";

import { createDesktopEditSessionsRoute } from "@/api/handlers/entities/desktop-edit-sessions-route";
import { createPdfSigningSessionsRoute } from "@/api/handlers/entities/pdf-signing-sessions-route";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";

const HANDOFF_TOKEN = "ab".repeat(32);

test("document handoffs require an authenticated desktop account", async () => {
  const dependencies = {
    authorizeAccount: authorizeDesktopAccount,
    recordFailure: async () => false,
  };
  const app = new Elysia()
    .use(createDesktopEditSessionsRoute(dependencies))
    .use(createPdfSigningSessionsRoute(dependencies));

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
    for (const authorization of [undefined, "Bearer unrelated-credential"]) {
      const response = await app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [DESKTOP_HANDOFF_PROTOCOL_HEADER]: String(
              DESKTOP_HANDOFF_PROTOCOL_VERSION,
            ),
            ...(authorization ? { authorization } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
      expect([path, authorization, response.status]).toEqual([
        path,
        authorization,
        401,
      ]);
    }
  }
});
