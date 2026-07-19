import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import {
  AGENT_AUTH_CLAIM_GRANT_TYPE,
  AGENT_AUTH_CLAIM_PATH,
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
import {
  getMcpResourceUrl,
  MCP_ANONYMIZED_RESOURCE_SCOPES,
} from "@/api/mcp/constants";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";

// These tests drive the agent-auth slice end to end against the same
// better-auth instance and database the API uses at runtime, so the token
// mint exercises the real authorization-code + JWT path.

type Json = Record<string, unknown>;

const jsonObjectSchema = v.record(v.string(), v.unknown());
/** Read a JSON response body as an object without an unsafe `any` assertion. */
const readJson = async (res: Response): Promise<Json> =>
  v.parse(jsonObjectSchema, await res.json());

/** Narrow a nested JSON value (e.g. the service_auth `claim` block) to an object. */
const asJson = (value: unknown): Json => v.parse(jsonObjectSchema, value);

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

const postClaim = async (body: Json) =>
  await agentAuthRoute.handle(
    new Request(`${BASE}${AGENT_AUTH_CLAIM_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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

beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

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
    email,
    userId: session.user.id,
    organizationId: session.session.activeOrganizationId,
  };
};

describe("agent-auth service_auth flow", () => {
  test("registration returns an RFC 8628 ceremony shape", async () => {
    const response = await postIdentity({ type: "service_auth" });
    expect(response.status).toBe(200);
    const body = await readJson(response);

    expect(body["registration_type"]).toBe("service_auth");
    expect(typeof body["registration_id"]).toBe("string");
    // Top-level handoff fields per the auth.md service guide. `claim_url` is
    // the claim ceremony endpoint, not the token grant the agent later polls.
    expect(typeof body["claim_token"]).toBe("string");
    expect(String(body["claim_url"])).toContain(AGENT_AUTH_CLAIM_PATH);
    expect(
      new Date(String(body["claim_token_expires"])).getTime(),
    ).toBeGreaterThan(Date.now());
    expect(
      v.parse(v.array(v.string()), body["post_claim_scopes"]).sort(),
    ).toEqual(["stella:read", "stella:search"]);
    // Ceremony fields nest under `claim`.
    const claim = asJson(body["claim"]);
    expect(typeof claim["user_code"]).toBe("string");
    expect(String(claim["verification_uri"])).toContain("/agent-claim");
    expect(String(claim["verification_uri_complete"])).toContain(
      encodeURIComponent(String(claim["user_code"])),
    );
    expect(claim["expires_in"]).toBeGreaterThan(0);
    expect(claim["interval"]).toBeGreaterThan(0);
    // The minted access token never appears on the service_auth ceremony.
    expect(body["access_token"]).toBeUndefined();
  });

  test("login_hint does not reveal whether the email maps to a user", async () => {
    const real = await createHumanSession();
    const realHintRes = await postIdentity({
      type: "service_auth",
      login_hint: real.email,
    });
    const unknownHintRes = await postIdentity({
      type: "service_auth",
      login_hint: `nobody-${Bun.randomUUIDv7()}@stella.dev`,
    });

    const realBody = await readJson(realHintRes);
    const unknownBody = await readJson(unknownHintRes);

    // Identical response shape (same keys) regardless of account existence.
    expect(Object.keys(realBody).sort()).toEqual(
      Object.keys(unknownBody).sort(),
    );
    expect(realBody["registration_type"]).toBe("service_auth");
    expect(unknownBody["registration_type"]).toBe("service_auth");
  });

  test("a non-email login_hint is rejected", async () => {
    // The hint gates confirmation against an account email; an arbitrary string
    // would make a permanently unclaimable ceremony, so it is rejected upfront.
    const res = await postIdentity({
      type: "service_auth",
      login_hint: "not-an-email",
    });
    expect(res.status).toBe(422);
  });

  test("poll is authorization_pending before confirm", async () => {
    const regRes = await postIdentity({ type: "service_auth" });
    const reg = await readJson(regRes);

    const pendingRes = await postToken({
      grant_type: AGENT_AUTH_CLAIM_GRANT_TYPE,
      claim_token: String(reg["claim_token"]),
    });
    expect(pendingRes.status).toBe(400);
    // Agents branch on the machine-readable OAuth `error` code, not `message`.
    const pendingBody = await readJson(pendingRes);
    expect(pendingBody["error"]).toBe("authorization_pending");
    expect(pendingBody["message"]).toBe("authorization_pending");
  });

  test("second poll inside the interval is throttled with slow_down", async () => {
    const regRes = await postIdentity({ type: "service_auth" });
    const claimToken = String((await readJson(regRes))["claim_token"]);

    await postToken({
      grant_type: AGENT_AUTH_CLAIM_GRANT_TYPE,
      claim_token: claimToken,
    });
    const throttledRes = await postToken({
      grant_type: AGENT_AUTH_CLAIM_GRANT_TYPE,
      claim_token: claimToken,
    });
    expect(throttledRes.status).toBe(400);
    expect((await readJson(throttledRes))["error"]).toBe("slow_down");
  });

  test("confirm binds the human + org and the poll mints a matching JWT", async () => {
    const human = await createHumanSession();

    const regRes = await postIdentity({ type: "service_auth" });
    const reg = await readJson(regRes);
    const claimToken = String(reg["claim_token"]);
    const userCode = String(asJson(reg["claim"])["user_code"]);

    // Confirm before any poll, so the first post-confirm poll is not
    // throttled by the server-side interval guard.
    const confirmRes = await postConfirm(
      { user_code: userCode },
      human.cookieHeader,
    );
    expect(confirmRes.status).toBe(200);
    expect((await readJson(confirmRes))["status"]).toBe("claimed");

    // After confirm: poll mints a JWT bound to the human + org.
    const tokenRes = await postToken({
      grant_type: AGENT_AUTH_CLAIM_GRANT_TYPE,
      claim_token: claimToken,
    });
    expect(tokenRes.status).toBe(200);
    // OAuth §5.1: the bearer-token response must not be cached.
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    const tokenBody = await readJson(tokenRes);
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
    const reg = await readJson(regRes);
    const confirmRes = await postConfirm(
      { user_code: String(asJson(reg["claim"])["user_code"]) },
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

  test("confirm requires the hinted email to match the confirming human", async () => {
    const owner = await createHumanSession();
    const intruder = await createHumanSession();

    const regRes = await postIdentity({
      type: "service_auth",
      login_hint: owner.email,
    });
    const userCode = String(
      asJson((await readJson(regRes))["claim"])["user_code"],
    );

    // A different signed-in member who intercepted the code cannot bind the
    // agent hinted at the owner's email — same 404 a wrong code would return.
    const intruderRes = await postConfirm(
      { user_code: userCode },
      intruder.cookieHeader,
    );
    expect(intruderRes.status).toBe(404);

    // The hinted owner can.
    const ownerRes = await postConfirm(
      { user_code: userCode },
      owner.cookieHeader,
    );
    expect(ownerRes.status).toBe(200);
  });

  test("a claimed user_code cannot be rebound by a second confirmer", async () => {
    const first = await createHumanSession();
    const second = await createHumanSession();

    const reg = await readJson(await postIdentity({ type: "service_auth" }));
    const userCode = String(asJson(reg["claim"])["user_code"]);
    const claimToken = String(reg["claim_token"]);

    expect(
      (await postConfirm({ user_code: userCode }, first.cookieHeader)).status,
    ).toBe(200);
    // The pending->claimed flip is conditional, so a racing/replayed confirm
    // from another member is rejected instead of overwriting the bound user.
    expect(
      (await postConfirm({ user_code: userCode }, second.cookieHeader)).status,
    ).toBe(404);

    // The minted token stays bound to the first confirmer.
    const tokenRes = await postToken({
      grant_type: AGENT_AUTH_CLAIM_GRANT_TYPE,
      claim_token: claimToken,
    });
    expect(tokenRes.status).toBe(200);
    const payload = decodeJwt(
      String((await readJson(tokenRes))["access_token"]),
    );
    expect(payload["sub"]).toBe(first.userId);
  });
});

describe("agent-auth anonymous flow", () => {
  test("anonymous registration mints a reduced-scope token immediately", async () => {
    const response = await postIdentity({ type: "anonymous" });
    expect(response.status).toBe(200);
    const body = await readJson(response);

    expect(body["registration_type"]).toBe("anonymous");
    expect(typeof body["claim_token"]).toBe("string");
    expect(body["token_type"]).toBe("Bearer");
    // The upgrade endpoint the agent posts claim_token + email to — the public
    // claim route, not the session-authed confirm route.
    expect(String(body["claim_uri"])).toContain(AGENT_AUTH_CLAIM_PATH);

    // Anonymous agents receive exactly the canonical anonymized resource
    // scopes (AGENT_AUTH_ANONYMOUS_SCOPES aliases this set); assert against it
    // so a scope added to the set does not silently drift from this check.
    const scopes = String(body["scope"]).split(" ").sort();
    expect(scopes).toEqual([...MCP_ANONYMIZED_RESOURCE_SCOPES].sort());

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

  test("claim upgrade returns a verification URI and is single-use", async () => {
    const anon = await readJson(await postIdentity({ type: "anonymous" }));
    const claimToken = String(anon["claim_token"]);

    const first = await postClaim({
      claim_token: claimToken,
      email: "owner@stella.dev",
    });
    expect(first.status).toBe(200);
    const firstBody = await readJson(first);
    // A client needs the user-facing URL to hand the human the returned code.
    expect(String(firstBody["verification_uri"])).toContain("/agent-claim");
    expect(String(firstBody["verification_uri_complete"])).toContain(
      encodeURIComponent(String(firstBody["user_code"])),
    );

    // The row is upgraded conditionally: a racing/retried claim on the same
    // (now consumed) anonymous token fails closed instead of clobbering the
    // first caller's user_code + credentials.
    const second = await postClaim({
      claim_token: claimToken,
      email: "someone-else@stella.dev",
    });
    expect(second.status).toBe(400);
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
    expect((await readJson(response))["accepted"]).toBe(true);
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
