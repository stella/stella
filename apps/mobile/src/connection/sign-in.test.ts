import { describe, expect, test } from "bun:test";

import {
  mobileClientMetadataUrl,
  mobileRedirectUri,
} from "@stll/api-contract/mobile-client";

import type { Fetch } from "./http";
import { deriveCodeChallenge } from "./pkce";
import { type OpenAuthSession, signIn } from "./sign-in";
import { unsignedIdToken } from "./test-support/id-token";
import { webCrypto } from "./test-support/web-crypto";

const SERVER = "https://stella.example.com";
const ISSUER = `${SERVER}/api/auth`;
const RESOURCE = `${SERVER}/v1`;
const CLIENT_ID = mobileClientMetadataUrl(ISSUER) ?? "";
const REDIRECT_URI = mobileRedirectUri("preview");

const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth2/authorize`,
  token_endpoint: `${ISSUER}/oauth2/token`,
  revocation_endpoint: `${ISSUER}/oauth2/revoke`,
  code_challenge_methods_supported: ["S256"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
};

type Tokens = { refresh_token?: string; id_token?: string };

const ID_TOKEN = unsignedIdToken({
  iss: ISSUER,
  aud: CLIENT_ID,
  sub: "user-1",
});

const ROTATING: Tokens = { refresh_token: "refresh-1", id_token: ID_TOKEN };

/**
 * A server publishing stella's metadata whose token endpoint redeems `code`
 * only for the verifier behind the challenge the browser was sent with.
 */
const stellaServer = (tokens: Tokens = ROTATING) => {
  const challenges = new Map<string, string>();
  const redeemed: URLSearchParams[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = input;
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return Response.json(METADATA);
    }
    if (url !== METADATA.token_endpoint) {
      return new Response(null, { status: 404 });
    }
    const body = new URLSearchParams(
      typeof init?.body === "string" ? init.body : "",
    );
    redeemed.push(body);
    const challenge = await deriveCodeChallenge(
      webCrypto,
      body.get("code_verifier") ?? "",
    );
    if (challenges.get(body.get("code") ?? "") !== challenge) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json({
      access_token: "access-1",
      expires_in: 900,
      token_type: "Bearer",
      ...tokens,
    });
  };
  /** The person approving in the browser; `answer` is what the callback carries. */
  const approve =
    (answer: (authorize: URL) => Record<string, string>): OpenAuthSession =>
    async (authorizeUrl, redirectUri) => {
      const authorize = new URL(authorizeUrl);
      challenges.set(
        "code-1",
        authorize.searchParams.get("code_challenge") ?? "",
      );
      const redirect = new URL(redirectUri);
      for (const [name, value] of Object.entries(answer(authorize))) {
        redirect.searchParams.set(name, value);
      }
      return await Promise.resolve({
        type: "success" as const,
        url: redirect.toString(),
      });
    };
  return { fetch, approve, redeemed };
};

const approved = (authorize: URL) => ({
  code: "code-1",
  state: authorize.searchParams.get("state") ?? "",
  iss: ISSUER,
});

const signInWith = async (
  server: ReturnType<typeof stellaServer>,
  openAuthSession: OpenAuthSession,
) =>
  await signIn({
    crypto: webCrypto,
    fetch: server.fetch,
    now: () => 1_000_000,
    openAuthSession,
    redirectUri: REDIRECT_URI,
    resourceFor: () => RESOURCE,
    serverUrlInput: SERVER,
    transport: { allowPlainHttp: false },
  });

describe("sign-in", () => {
  test("signs in with the app's client document and keeps the refresh token", async () => {
    const server = stellaServer();
    let authorizeUrl: URL | undefined;
    const result = await signInWith(
      server,
      server.approve((authorize) => {
        authorizeUrl = authorize;
        return approved(authorize);
      }),
    );
    expect(result.isOk() ? result.value : result.error).toEqual({
      session: {
        serverUrl: SERVER,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        tokenEndpoint: METADATA.token_endpoint,
        revocationEndpoint: METADATA.revocation_endpoint,
        resource: RESOURCE,
        refreshToken: "refresh-1",
        userId: "user-1",
      },
      access: { token: "access-1", expiresAt: 1_000_000 + 900_000 },
    });
    expect(authorizeUrl?.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorizeUrl?.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(authorizeUrl?.searchParams.get("resource")).toBe(RESOURCE);
    expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(
      Object.fromEntries(server.redeemed.at(0)?.entries() ?? []),
    ).toMatchObject({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: "code-1",
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    });
  });

  const failure = async (
    callback: (authorize: URL) => Record<string, string>,
    tokens?: Tokens,
  ) => {
    const server = stellaServer(tokens);
    const result = await signInWith(server, server.approve(callback));
    return {
      error: result.isErr() ? result.error._tag : "signed in",
      redeemed: server.redeemed.length,
    };
  };

  test("a callback for another attempt or another server is not redeemed", async () => {
    expect(
      await failure((authorize) => ({
        ...approved(authorize),
        state: "another-attempt",
      })),
    ).toEqual({ error: "AuthorizationError", redeemed: 0 });
    expect(
      await failure((authorize) => ({
        ...approved(authorize),
        iss: "https://elsewhere.example.com",
      })),
    ).toEqual({ error: "AuthorizationError", redeemed: 0 });
  });

  test("a closed browser ends the attempt without a token request", async () => {
    const server = stellaServer();
    const result = await signInWith(
      server,
      async () => await Promise.resolve({ type: "cancel" as const }),
    );
    expect(
      result.isErr() && result.error._tag === "AuthorizationError"
        ? result.error.failure
        : "signed in",
    ).toBe("cancelled");
    expect(server.redeemed).toHaveLength(0);
  });

  test("a session without a refresh token is refused", async () => {
    expect(await failure(approved, { id_token: ID_TOKEN })).toEqual({
      error: "TokenError",
      redeemed: 1,
    });
  });

  test("a session that cannot say whose it is is refused", async () => {
    expect(await failure(approved, { refresh_token: "refresh-1" })).toEqual({
      error: "TokenError",
      redeemed: 1,
    });
    expect(
      await failure(approved, {
        refresh_token: "refresh-1",
        id_token: unsignedIdToken({
          iss: ISSUER,
          aud: "another-client",
          sub: "user-1",
        }),
      }),
    ).toEqual({ error: "TokenError", redeemed: 1 });
  });
});
