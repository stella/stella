import { panic } from "better-result";
import { expect } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import * as v from "valibot";

import { sha256Bytes } from "@stll/sha256/browser";

import {
  member,
  organizationSsoPolicy,
  ssoProvider,
} from "@/api/db/auth-schema";
import { env } from "@/api/env";
import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import { withTestFetchInterceptor } from "@/api/tests/helpers/test-fetch";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// The identity provider answers in-process: its host only needs to pass the
// plugin's public-host check, and nothing leaves the test.
export const IDP_ORIGIN = "https://idp.sso-fixture.test";
export const CLIENT_ID = "stella-fixture-client";
const KEY_ID = "fixture-signing-key";

/**
 * How the next token response departs from a correct one: each field breaks
 * one thing the callback must verify.
 */
export type TokenFault = {
  /** Sign with a key the JWKS does not publish. */
  foreignKey?: boolean;
  issuer?: string;
  audience?: string;
  /** Seconds since expiry; the token expired this long ago. */
  expiredFor?: number;
  /** A nonce other than the one the authorization request carried. */
  nonce?: string | null;
  /** The subject the user-info endpoint reports. */
  userInfoSubject?: string;
};

/**
 * A local OIDC identity provider: generated signing keys, a JWKS document, a
 * user-info endpoint and a token endpoint that checks the PKCE verifier
 * against the authorization request's challenge and signs the ID token the
 * test asks for, with the authorization request's nonce.
 */
export const createIdentityProvider = async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const foreign = await generateKeyPair("RS256");
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid: KEY_ID,
    alg: "RS256",
    use: "sig",
  };
  let claims: JWTPayload = {};
  let fault: TokenFault = {};
  let authorization: { challenge: string | null; nonce: string | null } = {
    challenge: null,
    nonce: null,
  };
  const tokenExchanges: { verifierMatched: boolean }[] = [];

  const toChallenge = async (verifier: string) =>
    Buffer.from(await sha256Bytes(new TextEncoder().encode(verifier))).toBase64(
      { alphabet: "base64url", omitPadding: true },
    );

  const signIdToken = async () => {
    const nonce = fault.nonce === undefined ? authorization.nonce : fault.nonce;
    const now = Math.floor(Date.now() / 1000);
    const issuedAt =
      fault.expiredFor === undefined ? now : now - fault.expiredFor - 600;
    const expiresAt =
      fault.expiredFor === undefined ? now + 300 : now - fault.expiredFor;
    return await new SignJWT({
      ...claims,
      ...(nonce === null ? {} : { nonce }),
    })
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
      .setIssuer(fault.issuer ?? IDP_ORIGIN)
      .setAudience(fault.audience ?? CLIENT_ID)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(fault.foreignKey === true ? foreign.privateKey : privateKey);
  };

  const handle = async (url: URL, body: URLSearchParams): Promise<Response> => {
    switch (url.pathname) {
      case "/jwks":
        return Response.json({ keys: [publicJwk] });
      case "/userinfo":
        return Response.json({
          ...claims,
          sub: fault.userInfoSubject ?? claims.sub,
        });
      case "/token": {
        const verifier = body.get("code_verifier");
        const verifierMatched =
          verifier !== null &&
          authorization.challenge !== null &&
          (await toChallenge(verifier)) === authorization.challenge;
        tokenExchanges.push({ verifierMatched });
        if (!verifierMatched) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({
          access_token: "fixture-idp-access-token",
          refresh_token: "fixture-idp-refresh-token",
          id_token: await signIdToken(),
          token_type: "Bearer",
          expires_in: 300,
        });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  };
  return {
    /** The claims, and any fault, of the next ID token. */
    willAssert: (next: JWTPayload, nextFault: TokenFault = {}) => {
      claims = next;
      fault = nextFault;
    },
    /** What the browser's authorization request carried. */
    authorize: (url: URL) => {
      authorization = {
        challenge: url.searchParams.get("code_challenge"),
        nonce: url.searchParams.get("nonce"),
      };
    },
    handle,
    tokenExchanges,
  };
};

export type IdentityProvider = Awaited<
  ReturnType<typeof createIdentityProvider>
>;

export const unique = () => Bun.randomUUIDv7().replaceAll("-", "").slice(-12);

export const createOrganization = async (owner: HumanBrowser, name: string) =>
  await getAuth().api.createOrganization({
    body: { name, slug: `sso-${name}-${unique()}` },
    headers: owner.headers(),
  });

export const addMember = async (
  db: TestDatabase,
  organizationId: string,
  userId: string,
) => {
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(0),
  });
};

export type Provider = { id: string; providerId: string };

/** A correct provider configuration for the fixture identity provider. */
export const fixtureOidcConfig = (
  overrides: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    issuer: IDP_ORIGIN,
    clientId: CLIENT_ID,
    // oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- the stored provider configuration this fixture writes, with a fixture client secret; never logged
    clientSecret: "fixture-client-secret",
    authorizationEndpoint: `${IDP_ORIGIN}/authorize`,
    tokenEndpoint: `${IDP_ORIGIN}/token`,
    jwksEndpoint: `${IDP_ORIGIN}/jwks`,
    discoveryEndpoint: `${IDP_ORIGIN}/.well-known/openid-configuration`,
    pkce: true,
    scopes: ["openid", "email", "profile"],
    ...overrides,
  });

export const registerProvider = async (
  db: TestDatabase,
  organizationId: string,
  domains: readonly string[],
  options: { providerId?: string; config?: Record<string, unknown> } = {},
): Promise<Provider> => {
  const provider = {
    id: Bun.randomUUIDv7(),
    providerId: options.providerId ?? `sso_${unique()}`,
  };
  await db.insert(ssoProvider).values({
    ...provider,
    organizationId,
    issuer: IDP_ORIGIN,
    domain: domains.join(","),
    oidcConfig: fixtureOidcConfig(options.config),
  });
  return provider;
};

export const setSsoRequirement = async (
  db: TestDatabase,
  organizationId: string,
  requirement: "optional" | "required",
) => {
  await db
    .insert(organizationSsoPolicy)
    .values({ organizationId, requirement })
    .onConflictDoUpdate({
      target: organizationSsoPolicy.organizationId,
      set: { requirement },
    });
};

const cookiePairs = (response: Response): [string, string][] =>
  response.headers.getSetCookie().flatMap((cookie) => {
    const pair = cookie.split(";").at(0) ?? "";
    const separator = pair.indexOf("=");
    return separator <= 0
      ? []
      : [[pair.slice(0, separator), pair.slice(separator + 1)]];
  });

const signInStartSchema = v.object({ url: v.string(), redirect: v.boolean() });

/** A browser signed in through SSO: its cookie jar, like `HumanBrowser`. */
export type SsoBrowser = Omit<HumanBrowser, "userId"> & {
  /** Where the callback sent the browser. */
  location: URL;
  /** The signed-in user; null when the sign-in was refused. */
  userId: SafeId<"user"> | null;
};

/** The browser of a sign-in that succeeded, for helpers that take one. */
export const signedInBrowser = (browser: SsoBrowser): HumanBrowser => ({
  ...browser,
  userId: browser.userId ?? panic("the SSO sign-in was refused"),
});

type SsoSignInOptions = {
  fault?: TokenFault;
  /** Replace the state the callback receives. */
  state?: (issued: string) => string;
};

const requestBody = (init: RequestInit | undefined): URLSearchParams => {
  const raw = init?.body;
  if (typeof raw === "string") {
    return new URLSearchParams(raw);
  }
  if (raw instanceof URLSearchParams) {
    return raw;
  }
  return new URLSearchParams();
};

/**
 * One SSO sign-in through the real endpoints: start it, let the identity
 * provider assert `claims`, and follow the provider-specific callback.
 */
export const signInWithSso = async (
  idp: IdentityProvider,
  providerId: string,
  claims: JWTPayload,
  options: SsoSignInOptions = {},
): Promise<SsoBrowser> => {
  const address = `203.0.113.${String(Math.floor(Math.random() * 254) + 1)}`;
  const started = await getAuth().handler(
    new Request(getAuthEndpointUrl("sign-in/sso"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: new URL(env.FRONTEND_URL).origin,
        [AUTH_CLIENT_ADDRESS_HEADER]: address,
      },
      body: JSON.stringify({ providerId, callbackURL: "/" }),
    }),
  );
  expect(started.status).toBe(200);
  const { url } = v.parse(signInStartSchema, await started.json());
  const authorization = new URL(url);
  expect(authorization.origin).toBe(IDP_ORIGIN);
  const state =
    authorization.searchParams.get("state") ??
    panic("authorization request carried no state");
  idp.authorize(authorization);
  idp.willAssert(claims, options.fault);

  const callbackUrl = new URL(getAuthEndpointUrl(`sso/callback/${providerId}`));
  callbackUrl.searchParams.set("code", "fixture-authorization-code");
  callbackUrl.searchParams.set("state", options.state?.(state) ?? state);
  const jar = new Map(cookiePairs(started));
  const cookieHeader = () =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const callback = await withTestFetchInterceptor(
    async (input, init, delegate) => {
      const target = new URL(input instanceof Request ? input.url : input);
      return target.origin === IDP_ORIGIN
        ? await idp.handle(target, requestBody(init))
        : await delegate(input, init);
    },
    async () =>
      await getAuth().handler(
        new Request(callbackUrl.toString(), {
          headers: {
            cookie: cookieHeader(),
            [AUTH_CLIENT_ADDRESS_HEADER]: address,
          },
        }),
      ),
  );
  expect(callback.status).toBe(302);
  for (const [name, value] of cookiePairs(callback)) {
    jar.set(name, value);
  }
  const current = await sessionOf(cookieHeader());
  return {
    location: new URL(callback.headers.get("location") ?? "", env.FRONTEND_URL),
    email: current?.user.email ?? "",
    userId: current === null ? null : toSafeId<"user">(current.user.id),
    cookieHeader,
    headers: () => new Headers({ cookie: cookieHeader() }),
    setActiveOrganization: async (organizationId) => {
      const response = await getAuth().api.setActiveOrganization({
        body: { organizationId },
        headers: new Headers({ cookie: cookieHeader() }),
        asResponse: true,
      });
      if (!response.ok) {
        panic(`setActiveOrganization failed: ${String(response.status)}`);
      }
      for (const [name, value] of cookiePairs(response)) {
        jar.set(name, value);
      }
    },
  };
};

export const sessionOf = async (cookieHeader: string) =>
  await getAuth().api.getSession({
    headers: new Headers({ cookie: cookieHeader }),
    query: { disableCookieCache: true },
  });

export const verifiedClaims = (subject: string, email: string): JWTPayload => ({
  sub: subject,
  email,
  email_verified: true,
  name: "Fixture Person",
});
