import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { oauthClient, oauthConsent, session } from "@/api/db/auth-schema";
import { apiKeysRoute } from "@/api/handlers/api-keys/routes";
import { meRoute } from "@/api/handlers/me/routes";
import { getAuth } from "@/api/lib/auth";
import { requiresHandoffStepUpForAuthPath } from "@/api/lib/auth/handoff-step-up-policy";
import {
  createHumanSession,
  signInHuman,
} from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);
let db: TestDatabase;
beforeAll(async () => {
  db = await initAgentAuthTestDb();
});
afterAll(async () => await releaseAgentAuthTestDb());

const authoritativeHeaders = (cookie: string) =>
  new Headers({
    cookie: cookie
      .split("; ")
      .filter((pair) => !pair.split("=").at(0)?.includes("session_data"))
      .join("; "),
    "content-type": "application/json",
    origin: "http://localhost:3000",
  });

const expectStepUp = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(403);
  expect(await response.json()).toMatchObject({ code: "step_up_required" });
};

describe("handoff sessions enforce recent authentication at real entry points", () => {
  test("session and application macros plus Better Auth refuse account changes until reauthentication", async () => {
    const human = await createHumanSession({
      email: `handoff-step-up-${Bun.randomUUIDv7()}@stella.dev`,
      orgName: "Organization",
      orgSlugPrefix: "handoff-step-up",
    });
    const clientId = Bun.randomUUIDv7();
    const consentId = Bun.randomUUIDv7();
    await db
      .insert(oauthClient)
      .values({ id: clientId, clientId, redirectUris: [] });
    await db.insert(oauthConsent).values({
      id: consentId,
      clientId,
      userId: human.userId,
      referenceId: human.organizationId,
      scopes: [],
    });
    const current = await getAuth().api.getSession({
      headers: human.browser.headers(),
      query: { disableCookieCache: true },
    });
    expect(current).not.toBeNull();
    if (!current) {
      panic("Expected the signed-in session");
    }
    await db
      .update(session)
      .set({ originConsentId: consentId })
      .where(eq(session.id, current.session.id));
    const headers = authoritativeHeaders(human.browser.cookieHeader());
    const stored = await getAuth().api.getSession({
      headers,
      query: { disableCookieCache: true },
    });
    expect(stored?.session.originConsentId).toBe(consentId);
    await expectStepUp(
      await meRoute.handle(
        new Request(`http://localhost/me/oauth-connections/${consentId}`, {
          method: "DELETE",
          headers,
        }),
      ),
    );
    await expectStepUp(
      await apiKeysRoute.handle(
        new Request("http://localhost/api-keys/personal", {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Personal key" }),
        }),
      ),
    );
    await expectStepUp(
      await getAuth().handler(
        new Request("http://localhost:3000/api/auth/change-password", {
          method: "POST",
          headers,
          body: JSON.stringify({
            currentPassword: "current-password",
            newPassword: "replacement-password",
          }),
        }),
      ),
    );
    expect(
      await db
        .select()
        .from(oauthConsent)
        .where(eq(oauthConsent.id, consentId)),
    ).toHaveLength(1);

    const normal = await signInHuman(human.email);
    const refreshed = await getAuth().api.getSession({
      headers: normal.headers(),
      query: { disableCookieCache: true },
    });
    expect(refreshed?.session.originConsentId ?? null).toBeNull();
    const response = await getAuth().handler(
      new Request("http://localhost:3000/api/auth/revoke-other-sessions", {
        method: "POST",
        headers: authoritativeHeaders(normal.cookieHeader()),
        body: "{}",
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
  });

  test("registered sensitive plugin endpoints receive a policy decision", () => {
    const sensitivePluginIds = new Set([
      "organization",
      "two-factor",
      "passkey",
      "api-key",
      "oauth-provider",
      "sso",
      "scim",
      "email-otp",
    ]);
    const endpoints = (getAuth().options.plugins ?? []).flatMap((plugin) =>
      sensitivePluginIds.has(plugin.id)
        ? Object.entries(plugin.endpoints ?? {}).map(([name, endpoint]) => ({
            name,
            plugin: plugin.id,
            path: endpoint.path,
          }))
        : [],
    );
    expect(endpoints.length).toBeGreaterThan(20);
    for (const { plugin, path, name } of endpoints) {
      // Server-only API helpers expose no browser route to classify.
      if (typeof path !== "string") {
        expect(path, `${plugin}: ${name}`).toBeUndefined();
        continue;
      }
      if (
        plugin === "email-otp" &&
        !path.includes("change-email") &&
        !path.includes("request-email-change")
      ) {
        continue;
      }
      if (
        path.startsWith("/.well-known/") ||
        path.startsWith("/two-factor/verify-") ||
        path === "/oauth2/token" ||
        path.startsWith("/organization/list") ||
        path.startsWith("/organization/get-")
      ) {
        continue;
      }
      expect(requiresHandoffStepUpForAuthPath(path), `${plugin}: ${path}`).toBe(
        true,
      );
    }
  });
});
