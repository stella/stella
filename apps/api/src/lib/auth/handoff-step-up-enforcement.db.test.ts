import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
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
import Elysia from "elysia";

import { oauthClient, oauthConsent, session } from "@/api/db/auth-schema";
import { accountExportsRoute } from "@/api/handlers/account-exports/routes";
import { agentAuthConfirmRoute } from "@/api/handlers/agent-auth/routes";
import { apiKeysRoute } from "@/api/handlers/api-keys/routes";
import { meRoute } from "@/api/handlers/me/routes";
import { createAccountExportAuthMacro, getAuth } from "@/api/lib/auth";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/account-access";
import { HANDOFF_AUTH_ENDPOINT_POLICY } from "@/api/lib/auth/handoff-auth-endpoint-policy";
import { requiresHandoffStepUpForAuthPath } from "@/api/lib/auth/handoff-step-up-policy";
import { DESKTOP_REGISTRY_KEY_CONFIG } from "@/api/lib/business-registries/desktop/config";
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

// The SDK types pathless server helpers as endpoints, so inspect their runtime path.
const mountedEndpoints = (endpoints: Readonly<Record<string, unknown>>) =>
  Object.entries(endpoints).flatMap(([name, endpoint]) => {
    if (typeof endpoint !== "function" || !("path" in endpoint)) {
      return panic("Auth endpoint has no runtime path metadata");
    }
    const path = endpoint.path;
    if (path === undefined) {
      return [];
    }
    if (typeof path !== "string") {
      return panic("Auth endpoint has an invalid HTTP path");
    }
    return [{ name, path }];
  });

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
    expect(accountExportsRoute.routes).not.toHaveLength(0);
    for (const { method, path } of accountExportsRoute.routes) {
      await expectStepUp(
        await accountExportsRoute.handle(
          new Request(
            `http://localhost${path.replaceAll(":exportId", () => Bun.randomUUIDv7())}`,
            { method, headers },
          ),
        ),
      );
    }
    await expectStepUp(
      await meRoute.handle(
        new Request(`http://localhost/me/oauth-connections/${consentId}`, {
          method: "DELETE",
          headers,
        }),
      ),
    );
    await expectStepUp(
      await agentAuthConfirmRoute.handle(
        new Request("http://localhost/agent/identity/confirm", {
          method: "POST",
          headers,
          body: JSON.stringify({ user_code: "EXAMPLE" }),
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
    for (const path of ["/get-access-token", "/refresh-token"]) {
      await expectStepUp(
        await getAuth().handler(
          new Request(`http://localhost:3000/api/auth${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify({ accountId: "fixture-provider-account" }),
          }),
        ),
      );
    }
    expect(
      await db
        .select()
        .from(oauthConsent)
        .where(eq(oauthConsent.id, consentId)),
    ).toHaveLength(1);

    const normal = await signInHuman(human.email);
    // A handoff must never read the token of an ordinary session.
    await expectStepUp(
      await getAuth().handler(
        new Request("http://localhost:3000/api/auth/list-sessions", {
          headers,
        }),
      ),
    );
    const listed = await getAuth().handler(
      new Request("http://localhost:3000/api/auth/list-sessions", {
        headers: authoritativeHeaders(normal.cookieHeader()),
      }),
    );
    expect(listed.status, await listed.clone().text()).toBe(200);
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

  test("a cached account snapshot cannot revive a revoked export session", async () => {
    const human = await createHumanSession({
      email: `export-revoked-session-${Bun.randomUUIDv7()}@stella.dev`,
      orgName: "Organization",
      orgSlugPrefix: "export-revoked-session",
    });
    const snapshot = await getAuth().api.getSession({
      headers: human.browser.headers(),
      returnHeaders: true,
    });
    if (snapshot.response === null) {
      panic("Expected the signed-in account snapshot");
    }
    const sessionId = snapshot.response.session.id;
    await getAuth().api.signOut({ headers: human.browser.headers() });
    expect(
      await db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.id, sessionId)),
    ).toEqual([]);

    const app = new Elysia()
      .use(createAccountExportAuthMacro({ getSession: async () => snapshot }))
      .get("/export", () => ({ authenticated: true }), {
        validateAccountExport: "read",
        accountAccess: ACCOUNT_ACCESS.accountControl,
      });
    const response = await app.handle(
      new Request("http://localhost/export", {
        headers: human.browser.headers(),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("server-only authentication helpers retain their own refusal", async () => {
    const auth = getAuth();
    const registered = auth.api;
    expect(registered.verifyApiKey.path).toBeUndefined();
    const verified = await auth.api.verifyApiKey({
      body: {
        configId: DESKTOP_REGISTRY_KEY_CONFIG,
        key: "invalid-fixture-value",
      },
    });
    expect(verified.valid).toBe(false);
  });

  test("registered authentication methods remain available beside account management", async () => {
    const auth = getAuth();
    const registered = auth.api;
    const mounted = mountedEndpoints(registered);
    const census = (paths: readonly string[]) => {
      const mountedPaths = new Set(paths);
      const policyPaths = new Set(Object.keys(HANDOFF_AUTH_ENDPOINT_POLICY));
      return {
        missingFromPolicy: [...mountedPaths].filter(
          (path) => !policyPaths.has(path),
        ),
        absentFromAuth: [...policyPaths].filter(
          (path) => !mountedPaths.has(path),
        ),
      };
    };

    const mountedPaths = mounted.map(({ path }) => path);
    expect(mountedPaths).not.toContain("/");
    expect(registered.verifyApiKey.path).toBeUndefined();
    expect(registered.addMember.path).toBeUndefined();
    const verification = await auth.api.verifyApiKey({
      body: {
        configId: DESKTOP_REGISTRY_KEY_CONFIG,
        key: "nonexistent-fixture-key",
      },
    });
    expect(verification.valid).toBe(false);
    expect(census(mountedPaths)).toEqual({
      missingFromPolicy: [],
      absentFromAuth: [],
    });
    const policyByPath = new Map(Object.entries(HANDOFF_AUTH_ENDPOINT_POLICY));
    for (const { name, path } of mounted) {
      const disposition = policyByPath.get(path);
      expect(disposition, `${name}: ${path}`).toBeDefined();
      expect(requiresHandoffStepUpForAuthPath(path), `${name}: ${path}`).toBe(
        disposition === "refused",
      );
    }

    const futurePlugin = {
      id: "future-auth-method-fixture",
      endpoints: {
        futureAuthenticationMethod: createAuthEndpoint(
          "/future/authentication-method",
          { method: "POST" },
          async (ctx) => ctx.json({}),
        ),
      },
    } satisfies BetterAuthPlugin;
    const futureOptions = {
      ...auth.options,
      plugins: [...auth.options.plugins, futurePlugin],
    };
    const futureRegistered = betterAuth(futureOptions).api;
    const futurePaths = mountedEndpoints(futureRegistered).map(
      ({ path }) => path,
    );
    expect(census(futurePaths)).toEqual({
      missingFromPolicy: ["/future/authentication-method"],
      absentFromAuth: [],
    });
  });
});
