import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { CryptoKey, JWK } from "jose";
import * as v from "valibot";

import {
  AGENT_AUTH_CLAIM_PATH,
  AGENT_AUTH_CONFIRM_PATH,
  AGENT_AUTH_ID_JAG_ASSERTION_TYPE,
  AGENT_AUTH_ID_JAG_JWT_TYP,
  AGENT_AUTH_IDENTITY_PATH,
  AGENT_AUTH_JWT_BEARER_GRANT_TYPE,
  AGENT_AUTH_TOKEN_PATH,
} from "@/api/agent-auth/constants";
import {
  agentDelegation,
  agentTrustedIssuer,
} from "@/api/db/agent-auth-schema";
import { user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";
import {
  agentAuthConfirmRoute,
  agentAuthRoute,
} from "@/api/handlers/agent-auth/routes";
import { getAuth } from "@/api/lib/auth";
import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import { popDevOtp } from "@/api/lib/dev-otp-store";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";

// These tests drive the ID-JAG path end to end against the same
// better-auth instance + database the API uses at runtime. The external
// issuer is local: a jose-minted ES256 keypair whose JWKS is served by a
// stubbed `globalThis.fetch` for the issuer's well-known URL. A
// trusted-issuer row is inserted so the (empty-by-default) allow-list
// accepts it; every other issuer stays rejected.

type Json = Record<string, unknown>;

const jsonObjectSchema = v.record(v.string(), v.unknown());
/** Read a JSON response body as an object without an unsafe `any` assertion. */
const readJson = async (res: Response): Promise<Json> =>
  v.parse(jsonObjectSchema, await res.json());
/** Narrow an already-parsed JSON value to an object. */
const asJson = (value: unknown): Json => v.parse(jsonObjectSchema, value);

const BASE = "http://localhost";
const ISSUER = "https://idp.test.stella.dev";
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const CLIENT_ID = "test-agent-client";

let issuerKid: string;
let issuerPrivateKey: CryptoKey;
let issuerPublicJwk: JWK;
const realFetch = globalThis.fetch;

const enableFeature = () => {
  env.FEATURE_AGENT_ID_JAG = true;
};
const disableFeature = () => {
  env.FEATURE_AGENT_ID_JAG = false;
};

beforeAll(async () => {
  await initAgentAuthTestDb();
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  issuerPrivateKey = privateKey;
  issuerKid = "test-issuer-key";
  issuerPublicJwk = { ...(await exportJWK(publicKey)), kid: issuerKid };

  // Stub only the issuer JWKS URL; everything else hits the real fetch.
  const resolveUrl = (input: Parameters<typeof fetch>[0]): string => {
    if (typeof input === "string") {
      return input;
    }
    return input instanceof URL ? input.href : input.url;
  };
  const fetchStub = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = resolveUrl(input);
    if (url === JWKS_URL) {
      return new Response(JSON.stringify({ keys: [issuerPublicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return await realFetch(input, init);
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test stub: the call signature matches, but `typeof fetch` also carries a `preconnect` static this stub does not need
  globalThis.fetch = fetchStub as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  disableFeature();
  await releaseAgentAuthTestDb();
});

afterEach(async () => {
  await rootDb
    .delete(agentTrustedIssuer)
    .where(eq(agentTrustedIssuer.issuer, ISSUER));
  disableFeature();
});

const trustIssuer = async (attestationPolicy?: unknown) => {
  await rootDb
    .insert(agentTrustedIssuer)
    .values({
      issuer: ISSUER,
      displayName: "Test IdP",
      enabled: true,
      ...(attestationPolicy === undefined ? {} : { attestationPolicy }),
    })
    .onConflictDoNothing();
};

type IdJagOverrides = {
  email?: string;
  sub?: string;
  jti?: string;
  authTime?: number;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  iss?: string;
  aud?: string;
  amr?: string[];
};

const mintIdJag = async (overrides: IdJagOverrides = {}): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({
    client_id: CLIENT_ID,
    email: overrides.email ?? `idjag-${Bun.randomUUIDv7()}@external.test`,
    email_verified: overrides.emailVerified ?? true,
    ...(overrides.phoneVerified === undefined
      ? {}
      : { phone_number_verified: overrides.phoneVerified }),
    auth_time: overrides.authTime ?? now - 30,
    ...(overrides.amr ? { amr: overrides.amr } : {}),
  })
    .setProtectedHeader({
      alg: "ES256",
      typ: AGENT_AUTH_ID_JAG_JWT_TYP,
      kid: issuerKid,
    })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? getAuthIssuerUrl())
    .setSubject(overrides.sub ?? `sub-${Bun.randomUUIDv7()}`)
    .setJti(overrides.jti ?? Bun.randomUUIDv7())
    .setIssuedAt(now)
    .setExpirationTime(now + 300);
  return await builder.sign(issuerPrivateKey);
};

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

const identityAssertionBody = (assertion: string): Json => ({
  type: "identity_assertion",
  assertion_type: AGENT_AUTH_ID_JAG_ASSERTION_TYPE,
  assertion,
});

const decodeJwt = (jwt: string): Json => {
  const segment = jwt.split(".").at(1);
  if (!segment) {
    throw new Error("malformed jwt");
  }
  return JSON.parse(Buffer.from(segment, "base64url").toString());
};

/** Create a verified user with a password-less email, plus an org. */
const createHumanSession = async (email: string) => {
  const auth = getAuth();
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
    body: { name: "Existing Org", slug: `existing-${Bun.randomUUIDv7()}` },
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
    userId: session.user.id,
    organizationId: session.session.activeOrganizationId,
  };
};

describe("agent-auth ID-JAG dark-launch gate", () => {
  test("identity_assertion is rejected when the feature flag is off", async () => {
    disableFeature();
    await trustIssuer();
    const assertion = await mintIdJag();
    const res = await postIdentity(identityAssertionBody(assertion));
    expect(res.status).toBe(403);
    expect((await readJson(res))["error"]).toBe("issuer_not_enabled");
  });
});

describe("agent-auth ID-JAG trusted-issuer allow-list", () => {
  test("an untrusted issuer is rejected even with the feature on", async () => {
    enableFeature();
    // No trustIssuer() call: the allow-list is empty for this issuer.
    const assertion = await mintIdJag();
    const res = await postIdentity(identityAssertionBody(assertion));
    expect(res.status).toBe(403);
    expect((await readJson(res))["error"]).toBe("issuer_not_enabled");
  });

  test("a disabled trusted-issuer row is rejected", async () => {
    enableFeature();
    await rootDb.insert(agentTrustedIssuer).values({
      issuer: ISSUER,
      displayName: "Test IdP (disabled)",
      enabled: false,
    });
    const assertion = await mintIdJag();
    const res = await postIdentity(identityAssertionBody(assertion));
    expect(res.status).toBe(403);
    expect((await readJson(res))["error"]).toBe("issuer_not_enabled");
  });
});

describe("agent-auth ID-JAG new identity (auto-provision)", () => {
  test("a trusted new identity provisions a user + org and writes a delegation", async () => {
    enableFeature();
    await trustIssuer();
    const email = `idjag-new-${Bun.randomUUIDv7()}@external.test`;
    const sub = `sub-new-${Bun.randomUUIDv7()}`;
    const assertion = await mintIdJag({ email, sub });

    const res = await postIdentity(identityAssertionBody(assertion));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body["registration_type"]).toBe("identity_assertion");
    expect(typeof body["identity_assertion"]).toBe("string");
    // Absolute expiry timestamp (spec shape), not a relative TTL.
    expect(
      new Date(String(body["assertion_expires"])).getTime(),
    ).toBeGreaterThan(Date.now());
    expect(v.parse(v.array(v.string()), body["scopes"]).sort()).toEqual([
      "stella:read",
      "stella:search",
    ]);

    // The user now exists and a (iss, sub) delegation was written.
    const users = await rootDb
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    expect(users.length).toBe(1);

    const delegations = await rootDb
      .select({
        userId: agentDelegation.userId,
        organizationId: agentDelegation.organizationId,
      })
      .from(agentDelegation)
      .where(eq(agentDelegation.sub, sub))
      .limit(1);
    expect(delegations.length).toBe(1);
    expect(delegations.at(0)?.userId).toBe(String(users.at(0)?.id));
    expect(typeof delegations.at(0)?.organizationId).toBe("string");
  });
});

describe("agent-auth ID-JAG replay + freshness", () => {
  test("a replayed jti is rejected", async () => {
    enableFeature();
    await trustIssuer();
    const jti = `jti-replay-${Bun.randomUUIDv7()}`;
    const first = await mintIdJag({ jti });
    const second = await mintIdJag({ jti });

    const firstRes = await postIdentity(identityAssertionBody(first));
    expect(firstRes.status).toBe(200);

    const secondRes = await postIdentity(identityAssertionBody(second));
    expect(secondRes.status).toBe(401);
    expect((await readJson(secondRes))["error"]).toBe("invalid_assertion");
  });

  test("a stale auth_time returns 401 login_required", async () => {
    enableFeature();
    await trustIssuer();
    const staleAuthTime = Math.floor(Date.now() / 1000) - 7200;
    const assertion = await mintIdJag({ authTime: staleAuthTime });
    const res = await postIdentity(identityAssertionBody(assertion));
    expect(res.status).toBe(401);
    expect((await readJson(res))["error"]).toBe("login_required");
  });

  test("an unverified email is rejected", async () => {
    enableFeature();
    await trustIssuer();
    const assertion = await mintIdJag({ emailVerified: false });
    const res = await postIdentity(identityAssertionBody(assertion));
    expect(res.status).toBe(401);
    expect((await readJson(res))["error"]).toBe("invalid_assertion");
  });

  test("a verified phone does not vouch for an unverified email", async () => {
    enableFeature();
    await trustIssuer();
    // We resolve/provision by the email claim, so a verified phone alongside
    // an unverified email must NOT pass — otherwise an issuer could bind an
    // email it never verified.
    const assertion = await mintIdJag({
      emailVerified: false,
      phoneVerified: true,
    });
    const res = await postIdentity(identityAssertionBody(assertion));
    expect(res.status).toBe(401);
    expect((await readJson(res))["error"]).toBe("invalid_assertion");
  });

  test("a malformed email claim is rejected before account resolution", async () => {
    enableFeature();
    await trustIssuer();
    // `email_verified: true` does not prove the value is a valid address; a
    // malformed claim must not reach user lookup / auto-provisioning.
    const assertion = await mintIdJag({ email: "not-an-email" });
    const res = await postIdentity(identityAssertionBody(assertion));
    expect(res.status).toBe(401);
    expect((await readJson(res))["error"]).toBe("invalid_assertion");
  });
});

describe("agent-auth ID-JAG existing email (step-up, no silent bind)", () => {
  test("an existing-email identity with no delegation forces interaction_required", async () => {
    enableFeature();
    await trustIssuer();
    const email = `idjag-existing-${Bun.randomUUIDv7()}@stella.dev`;
    const sub = `sub-existing-${Bun.randomUUIDv7()}`;
    const human = await createHumanSession(email);

    const assertion = await mintIdJag({ email, sub });
    const res = await postIdentity(identityAssertionBody(assertion));
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body["error"]).toBe("interaction_required");

    // Ceremony fields nest under `claim`; the registration handles ride at
    // the top level, mirroring the service_auth registration envelope so an
    // agent parses the step-up with one shape.
    const claim = asJson(body["claim"]);
    expect(typeof claim["user_code"]).toBe("string");
    expect(String(claim["verification_uri"])).toContain("/agent-claim");

    expect(body["registration_type"]).toBe("identity_assertion");
    expect(String(body["claim_url"])).toContain(AGENT_AUTH_CLAIM_PATH);
    expect(typeof body["claim_token"]).toBe("string");
    expect(
      new Date(String(body["claim_token_expires"])).getTime(),
    ).toBeGreaterThan(Date.now());
    expect(Array.isArray(body["post_claim_scopes"])).toBe(true);

    // No silent bind: no delegation exists yet for this exact identity.
    const before = await rootDb
      .select({ userId: agentDelegation.userId })
      .from(agentDelegation)
      .where(eq(agentDelegation.sub, sub));
    expect(before.length).toBe(0);

    // The human completes the step-up ceremony; only then is the
    // (iss, sub) delegation written, bound to the confirming user + org.
    const confirmRes = await postConfirm(
      { user_code: String(claim["user_code"]) },
      human.cookieHeader,
    );
    expect(confirmRes.status).toBe(200);

    const after = await rootDb
      .select({
        userId: agentDelegation.userId,
        organizationId: agentDelegation.organizationId,
      })
      .from(agentDelegation)
      .where(eq(agentDelegation.sub, sub))
      .limit(1);
    expect(after.length).toBe(1);
    expect(after.at(0)?.userId).toBe(human.userId);
    expect(after.at(0)?.organizationId).toBe(human.organizationId);
  });

  test("an existing user is matched despite email casing", async () => {
    enableFeature();
    await trustIssuer();
    const email = `idjag-case-${Bun.randomUUIDv7()}@stella.dev`;
    const sub = `sub-case-${Bun.randomUUIDv7()}`;
    await createHumanSession(email);

    // The issuer sends the same mailbox in a different case; canonicalisation
    // must still resolve the existing account (step-up), not auto-provision a
    // duplicate — a mismatch here would return `ready`, not the 401 step-up.
    const assertion = await mintIdJag({ email: email.toUpperCase(), sub });
    const res = await postIdentity(identityAssertionBody(assertion));
    expect(res.status).toBe(401);
    expect((await readJson(res))["error"]).toBe("interaction_required");
  });
});

describe("agent-auth ID-JAG full exchange", () => {
  test("a clean match exchanges the service assertion for a bound JWT", async () => {
    enableFeature();
    await trustIssuer();
    const email = `idjag-exchange-${Bun.randomUUIDv7()}@external.test`;
    const sub = `sub-exchange-${Bun.randomUUIDv7()}`;
    const assertion = await mintIdJag({ email, sub });

    const idRes = await postIdentity(identityAssertionBody(assertion));
    expect(idRes.status).toBe(200);
    const idBody = await readJson(idRes);
    const serviceAssertion = String(idBody["identity_assertion"]);

    const tokenRes = await postToken({
      grant_type: AGENT_AUTH_JWT_BEARER_GRANT_TYPE,
      assertion: serviceAssertion,
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await readJson(tokenRes);
    expect(tokenBody["token_type"]).toBe("Bearer");
    expect(String(tokenBody["scope"]).split(" ").sort()).toEqual([
      "stella:read",
      "stella:search",
    ]);

    const accessToken = String(tokenBody["access_token"]);
    expect(accessToken.split(".")).toHaveLength(3);
    const payload = decodeJwt(accessToken);
    expect(payload["aud"]).toBe(getMcpResourceUrl("default"));
    expect(typeof payload["sub"]).toBe("string");
    expect(typeof payload["org_id"]).toBe("string");

    // The (iss, sub) delegation binds the token's principal.
    const delegations = await rootDb
      .select({
        userId: agentDelegation.userId,
        organizationId: agentDelegation.organizationId,
      })
      .from(agentDelegation)
      .where(eq(agentDelegation.sub, sub))
      .limit(1);
    expect(delegations.at(0)?.userId).toBe(String(payload["sub"]));
    expect(delegations.at(0)?.organizationId).toBe(String(payload["org_id"]));

    // The intermediate assertion is one-shot: a second exchange fails.
    const replayRes = await postToken({
      grant_type: AGENT_AUTH_JWT_BEARER_GRANT_TYPE,
      assertion: serviceAssertion,
    });
    expect(replayRes.status).toBe(400);
  });

  test("a returning delegation routes straight through without a step-up", async () => {
    enableFeature();
    await trustIssuer();
    const email = `idjag-return-${Bun.randomUUIDv7()}@external.test`;
    const sub = `sub-return-${Bun.randomUUIDv7()}`;

    const first = await postIdentity(
      identityAssertionBody(await mintIdJag({ email, sub })),
    );
    expect(first.status).toBe(200);

    // A second assertion for the same (iss, sub) is a delegation hit:
    // still 200 (ready), never a step-up.
    const second = await postIdentity(
      identityAssertionBody(await mintIdJag({ email, sub })),
    );
    expect(second.status).toBe(200);
    expect((await readJson(second))["registration_type"]).toBe(
      "identity_assertion",
    );
  });
});
