import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  AGENT_AUTH_CLAIM_GRANT_TYPE,
  AGENT_AUTH_CONFIRM_PATH,
  AGENT_AUTH_IDENTITY_PATH,
  AGENT_AUTH_TOKEN_PATH,
} from "@/api/agent-auth/constants";
import { agentRegistration } from "@/api/db/agent-auth-schema";
import { rootDb } from "@/api/db/root";
import { isAgentAuthRateLimitedPath } from "@/api/handlers/agent-auth/rate-limit";
import {
  agentAuthConfirmRoute,
  agentAuthRoute,
} from "@/api/handlers/agent-auth/routes";
import { getAuth } from "@/api/lib/auth";
import { popDevOtp } from "@/api/lib/dev-otp-store";
import { getMcpResourceUrl } from "@/api/mcp/constants";

// These tests drive the agent-auth slice end to end against the same
// better-auth instance and database the API uses at runtime, so the token
// mint exercises the real authorization-code + JWT path.

type Json = Record<string, unknown>;

const BASE = "http://localhost";

const postIdentity = async (body: Json) =>
  await agentAuthRoute.handle(
    new Request(`${BASE}${AGENT_AUTH_IDENTITY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const postToken = async (body: Json) =>
  await agentAuthRoute.handle(
    new Request(`${BASE}${AGENT_AUTH_TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const postConfirm = async (body: Json, cookieHeader: string) =>
  await agentAuthConfirmRoute.handle(
    new Request(`${BASE}${AGENT_AUTH_CONFIRM_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify(body),
    }),
  );

const decodeJwt = (jwt: string): Json => {
  const segment = jwt.split(".").at(1);
  if (!segment) {
    throw new Error("malformed jwt");
  }
  return JSON.parse(Buffer.from(segment, "base64url").toString());
};

/** Create a verified user, an org, and an active session cookie. */
const createHumanSession = async () => {
  const auth = getAuth();
  const email = `agent-test-${Bun.randomUUIDv7()}@stella.dev`;
  await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
  const otp = popDevOtp(email);
  if (!otp) {
    throw new Error("dev OTP not stashed; is env.isDev true under test?");
  }
  const signInRes = await auth.api.signInEmailOTP({
    body: { email, otp },
    asResponse: true,
  });
  const cookieHeader = (signInRes.headers.get("set-cookie") ?? "")
    .split(",")
    .map((part) => part.split(";").at(0)?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("; ");

  const headers = new Headers({ cookie: cookieHeader });
  const org = await auth.api.createOrganization({
    body: { name: "Agent Test Org", slug: `agent-test-${Bun.randomUUIDv7()}` },
    headers,
  });
  if (!org) {
    throw new Error("failed to create org");
  }
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });
  const session = await auth.api.getSession({ headers });
  if (!session?.user || !session.session.activeOrganizationId) {
    throw new Error("session not active for org");
  }
  return {
    cookieHeader,
    userId: session.user.id,
    organizationId: session.session.activeOrganizationId,
  };
};

describe("agent-auth service_auth flow", () => {
  test("registration returns an RFC 8628 ceremony shape", async () => {
    const response = await postIdentity({ type: "service_auth" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Json;

    expect(body["registration_type"]).toBe("service_auth");
    expect(typeof body["registration_id"]).toBe("string");
    expect(typeof body["user_code"]).toBe("string");
    expect(typeof body["claim_token"]).toBe("string");
    expect(body["verification_uri"]).toContain("/agent-claim");
    expect(String(body["verification_uri_complete"])).toContain(
      encodeURIComponent(String(body["user_code"])),
    );
    expect(body["expires_in"]).toBeGreaterThan(0);
    expect(body["interval"]).toBeGreaterThan(0);
    // The minted access token never appears on the service_auth ceremony.
    expect(body["access_token"]).toBeUndefined();
  });

  test("login_hint does not reveal whether the email maps to a user", async () => {
    const real = await createHumanSession();
    const realHintRes = await postIdentity({
      type: "service_auth",
      login_hint: `known-${real.userId}@stella.dev`,
    });
    const unknownHintRes = await postIdentity({
      type: "service_auth",
      login_hint: `nobody-${Bun.randomUUIDv7()}@stella.dev`,
    });

    const realBody = (await realHintRes.json()) as Json;
    const unknownBody = (await unknownHintRes.json()) as Json;

    // Identical response shape (same keys) regardless of account existence.
    expect(Object.keys(realBody).sort()).toEqual(
      Object.keys(unknownBody).sort(),
    );
    expect(realBody["registration_type"]).toBe("service_auth");
    expect(unknownBody["registration_type"]).toBe("service_auth");
  });

  test("poll is authorization_pending before confirm", async () => {
    const regRes = await postIdentity({ type: "service_auth" });
    const reg = (await regRes.json()) as Json;

    const pendingRes = await postToken({
      grant_type: AGENT_AUTH_CLAIM_GRANT_TYPE,
      claim_token: String(reg["claim_token"]),
    });
    expect(pendingRes.status).toBe(400);
    expect(((await pendingRes.json()) as Json)["message"]).toBe(
      "authorization_pending",
    );
  });

  test("second poll inside the interval is throttled with slow_down", async () => {
    const regRes = await postIdentity({ type: "service_auth" });
    const claimToken = String(((await regRes.json()) as Json)["claim_token"]);

    await postToken({
      grant_type: AGENT_AUTH_CLAIM_GRANT_TYPE,
      claim_token: claimToken,
    });
    const throttledRes = await postToken({
      grant_type: AGENT_AUTH_CLAIM_GRANT_TYPE,
      claim_token: claimToken,
    });
    expect(throttledRes.status).toBe(400);
    expect(((await throttledRes.json()) as Json)["message"]).toBe("slow_down");
  });

  test("confirm binds the human + org and the poll mints a matching JWT", async () => {
    const human = await createHumanSession();

    const regRes = await postIdentity({ type: "service_auth" });
    const reg = (await regRes.json()) as Json;
    const claimToken = String(reg["claim_token"]);
    const userCode = String(reg["user_code"]);

    // Confirm before any poll, so the first post-confirm poll is not
    // throttled by the server-side interval guard.
    const confirmRes = await postConfirm(
      { user_code: userCode },
      human.cookieHeader,
    );
    expect(confirmRes.status).toBe(200);
    expect(((await confirmRes.json()) as Json)["status"]).toBe("claimed");

    // After confirm: poll mints a JWT bound to the human + org.
    const tokenRes = await postToken({
      grant_type: AGENT_AUTH_CLAIM_GRANT_TYPE,
      claim_token: claimToken,
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as Json;
    expect(tokenBody["token_type"]).toBe("Bearer");
    expect(tokenBody["expires_in"]).toBeGreaterThan(0);
    expect(String(tokenBody["scope"]).split(" ").sort()).toEqual([
      "stella:read",
      "stella:search",
    ]);

    const accessToken = String(tokenBody["access_token"]);
    expect(accessToken.split(".")).toHaveLength(3);
    const payload = decodeJwt(accessToken);
    expect(payload["sub"]).toBe(human.userId);
    expect(payload["org_id"]).toBe(human.organizationId);
    expect(payload["aud"]).toBe(getMcpResourceUrl("default"));
    expect(String(payload["scope"]).split(" ").sort()).toEqual([
      "stella:read",
      "stella:search",
    ]);

    // The code is one-shot: it is cleared from the registration the
    // moment it is exchanged, so a replay (after the poll interval) can
    // never mint a second token.
    const rows = await rootDb
      .select({ authorizationCode: agentRegistration.authorizationCode })
      .from(agentRegistration)
      .where(eq(agentRegistration.id, String(reg["registration_id"])))
      .limit(1);
    expect(rows.at(0)?.authorizationCode).toBeNull();
  });

  test("confirm without a session is rejected", async () => {
    const regRes = await postIdentity({ type: "service_auth" });
    const reg = (await regRes.json()) as Json;
    const confirmRes = await postConfirm(
      { user_code: String(reg["user_code"]) },
      "",
    );
    expect(confirmRes.status).toBe(401);
  });

  test("confirm with an unknown user_code is 404", async () => {
    const human = await createHumanSession();
    const confirmRes = await postConfirm(
      { user_code: "ZZZZ-9999" },
      human.cookieHeader,
    );
    expect(confirmRes.status).toBe(404);
  });
});

describe("agent-auth anonymous flow", () => {
  test("anonymous registration mints a reduced-scope token immediately", async () => {
    const response = await postIdentity({ type: "anonymous" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Json;

    expect(body["registration_type"]).toBe("anonymous");
    expect(typeof body["claim_token"]).toBe("string");
    expect(body["token_type"]).toBe("Bearer");

    const scopes = String(body["scope"]).split(" ").sort();
    expect(scopes).toEqual([
      "stella:read_anonymized",
      "stella:search_anonymized",
    ]);

    const accessToken = String(body["access_token"]);
    expect(accessToken.split(".")).toHaveLength(3);
    const payload = decodeJwt(accessToken);
    // No org principal on an anonymous token.
    expect(payload["sub"]).toBeUndefined();
    expect(payload["org_id"]).toBeUndefined();
    expect(payload["aud"]).toBe(getMcpResourceUrl("anonymized"));
    // It cannot carry default (member-scoped) scopes.
    expect(String(payload["scope"])).not.toContain("stella:read ");
    expect(String(payload["scope"])).not.toContain("stella:search ");
  });
});

describe("agent-auth events receiver", () => {
  test("accepts a SET with 202 and does not act on it", async () => {
    const response = await agentAuthRoute.handle(
      new Request(`${BASE}/agent/event/notify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("eyJ.fake.set"),
      }),
    );
    expect(response.status).toBe(202);
    expect(((await response.json()) as Json)["accepted"]).toBe(true);
  });
});

describe("agent-auth rate-limit path matcher", () => {
  test("matches the unauthenticated endpoints, not confirm", () => {
    expect(isAgentAuthRateLimitedPath(AGENT_AUTH_IDENTITY_PATH)).toBe(true);
    expect(isAgentAuthRateLimitedPath("/agent/identity/claim")).toBe(true);
    expect(isAgentAuthRateLimitedPath(AGENT_AUTH_TOKEN_PATH)).toBe(true);
    expect(isAgentAuthRateLimitedPath("/agent/event/notify")).toBe(true);
    expect(isAgentAuthRateLimitedPath(AGENT_AUTH_CONFIRM_PATH)).toBe(false);
  });
});
