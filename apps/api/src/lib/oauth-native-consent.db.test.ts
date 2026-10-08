import type { OAuthConsent, SchemaClient } from "@better-auth/oauth-provider";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const metadataByUrl = new Map<string, unknown>();
const metadataRequestsByUrl = new Map<string, number>();

await mock.module("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    metadataRequestsByUrl.set(url, (metadataRequestsByUrl.get(url) ?? 0) + 1);
    const document = metadataByUrl.get(url);
    if (document === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(document), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
      status: 200,
    });
  },
}));

const { getAuth } = await import("@/api/lib/auth");
const { getAuthEndpointUrl } = await import("@/api/lib/auth/auth-paths");
const { AUTH_CLIENT_ADDRESS_HEADER } = await import("@/api/lib/client-ip");
const { signInHuman } = await import("@/api/tests/helpers/human-session");
const { initAgentAuthTestDb, releaseAgentAuthTestDb } =
  await import("@/api/tests/helpers/mock-agent-auth-db");
const { readOAuthRedirect, readSignedQuery } =
  await import("@/api/tests/helpers/oauth-grant");

beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const CLIENT_FIXTURES = {
  dcrPublic: {
    kind: "dcrPublic",
    name: "DCR public",
    applicationType: "native",
    tokenEndpointAuthMethod: "none",
  },
  cimdPublic: {
    kind: "cimdPublic",
    name: "CIMD public",
    applicationType: "native",
    tokenEndpointAuthMethod: "none",
  },
  dcrConfidential: {
    kind: "dcrConfidential",
    name: "DCR confidential",
    applicationType: "native",
    tokenEndpointAuthMethod: "client_secret_post",
  },
} as const;

const REDIRECT_FIXTURES = {
  loopbackIpv4: {
    kind: "loopbackIpv4",
    name: "IPv4 loopback",
    uri: "http://127.0.0.1:51001/oauth/callback",
  },
  loopbackIpv6: {
    kind: "loopbackIpv6",
    name: "IPv6 loopback",
    uri: "http://[::1]:51002/oauth/callback",
  },
  loopbackLocalhost: {
    kind: "loopbackLocalhost",
    name: "localhost loopback",
    uri: "http://localhost:51003/oauth/callback",
  },
  privateScheme: {
    kind: "privateScheme",
    name: "private custom scheme",
    uri: "com.example.native:/oauth/callback",
  },
  hostedHttps: {
    kind: "hostedHttps",
    name: "hosted HTTPS",
    uri: "https://connector.example.test/oauth/callback",
  },
} as const;

const REPEAT_BEHAVIOR = {
  dcrPublic: {
    loopbackIpv4: "consent",
    loopbackIpv6: "consent",
    loopbackLocalhost: "consent",
    privateScheme: "consent",
    hostedHttps: "code",
  },
  cimdPublic: {
    loopbackIpv4: "consent",
    loopbackIpv6: "consent",
    loopbackLocalhost: "consent",
    privateScheme: "consent",
    hostedHttps: "code",
  },
  dcrConfidential: {
    loopbackIpv4: "code",
    loopbackIpv6: "code",
    loopbackLocalhost: "code",
    privateScheme: "code",
    hostedHttps: "code",
  },
} as const satisfies Record<
  keyof typeof CLIENT_FIXTURES,
  Record<keyof typeof REDIRECT_FIXTURES, "consent" | "code">
>;

const consentCases = Object.values(CLIENT_FIXTURES).flatMap((client) =>
  Object.values(REDIRECT_FIXTURES).map((redirect) => ({
    name: `${client.name} ${redirect.name}`,
    clientKind: client.kind,
    redirectKind: redirect.kind,
    redirectUri: redirect.uri,
    applicationType: client.applicationType,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
  })),
);

const registrationSchema = v.looseObject({ client_id: v.string() });

let requestCount = 0;
let cimdClientCount = 0;
const nextClientAddress = () => {
  requestCount += 1;
  return `198.51.${String(100 + Math.floor(requestCount / 250))}.${String((requestCount % 250) + 1)}`;
};

const clientAddressHeaders = () => {
  const address = nextClientAddress();
  // Direct auth-handler calls supply the address the HTTP boundary resolves.
  return { "x-forwarded-for": address, [AUTH_CLIENT_ADDRESS_HEADER]: address };
};

type AuthorizeOptions = {
  browser: Awaited<ReturnType<typeof signInHuman>>;
  clientId: string;
  method: "GET" | "POST";
  prompt?: string;
  redirectUri: string;
};

type ConsentCase = (typeof consentCases)[number];

const createClient = async (scenario: ConsentCase): Promise<string> => {
  if (scenario.clientKind === "cimdPublic") {
    cimdClientCount += 1;
    const clientId = `https://native-client-${String(cimdClientCount)}.example.test/oauth/client-metadata.json`;
    metadataByUrl.set(clientId, {
      application_type: scenario.applicationType,
      client_id: clientId,
      client_name: "Native metadata client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [scenario.redirectUri],
      response_types: ["code"],
      scope: "openid",
      token_endpoint_auth_method: scenario.tokenEndpointAuthMethod,
    });
    return clientId;
  }

  const registered = await getAuth().handler(
    new Request(getAuthEndpointUrl("oauth2/register"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...clientAddressHeaders(),
      },
      body: JSON.stringify({
        application_type: scenario.applicationType,
        client_name: scenario.name,
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [scenario.redirectUri],
        response_types: ["code"],
        scope: "openid",
        token_endpoint_auth_method: scenario.tokenEndpointAuthMethod,
      }),
    }),
  );
  expect(
    registered.status,
    `${scenario.name} registration failed: ${await registered.clone().text()}`,
  ).toBe(201);
  return v.parse(registrationSchema, await registered.json()).client_id;
};

const authorize = async ({
  browser,
  clientId,
  method,
  prompt,
  redirectUri,
}: AuthorizeOptions): Promise<URL> => {
  const query = new URLSearchParams({
    client_id: clientId,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid",
    ...(prompt === undefined ? {} : { prompt }),
  });
  const endpoint = getAuthEndpointUrl("oauth2/authorize");
  const response = await getAuth().handler(
    new Request(
      method === "GET" ? `${endpoint}?${query.toString()}` : endpoint,
      {
        method,
        headers: {
          accept: "application/json",
          ...(method === "POST"
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {}),
          cookie: browser.cookieHeader(),
          ...clientAddressHeaders(),
        },
        ...(method === "POST" ? { body: query.toString() } : {}),
      },
    ),
  );
  return await readOAuthRedirect(response);
};

const consentAndReadRedirect = async (
  browser: Awaited<ReturnType<typeof signInHuman>>,
  consentPage: URL,
): Promise<URL> => {
  expect(consentPage.pathname).toBe("/consent");
  const response = await getAuth().handler(
    new Request(getAuthEndpointUrl("oauth2/consent"), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: browser.cookieHeader(),
        ...clientAddressHeaders(),
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: readSignedQuery(consentPage),
      }),
    }),
  );
  return await readOAuthRedirect(response);
};

describe("OAuth native client consent", () => {
  test("exercises every declared client and redirect kind combination", () => {
    const exercised = consentCases.map(
      ({ clientKind, redirectKind }) => `${clientKind}/${redirectKind}`,
    );
    const declared = Object.keys(CLIENT_FIXTURES).flatMap((clientKind) =>
      Object.keys(REDIRECT_FIXTURES).map(
        (redirectKind) => `${clientKind}/${redirectKind}`,
      ),
    );
    expect(new Set(exercised)).toEqual(new Set(declared));
    expect(exercised).toHaveLength(declared.length);
  });

  test.each(
    consentCases.flatMap((scenario) =>
      (["GET", "POST"] as const).map(
        (method) => [scenario.name, method, scenario] as const,
      ),
    ),
  )("applies consent policy to %s via %s", async (_name, method, scenario) => {
    const clientId = await createClient(scenario);
    const browser = await signInHuman(
      `native-consent-${String(requestCount)}@example.test`,
    );

    // No prior consent exists on this first authorization.
    const firstPage = await authorize({
      browser,
      clientId,
      method,
      redirectUri: scenario.redirectUri,
    });
    expect(firstPage.pathname).toBe("/consent");
    expect(firstPage.searchParams.has("code")).toBe(false);
    const context = await getAuth().$context;
    const issuedCodes = async () =>
      await context.adapter.count({
        model: "verification",
        where: [
          {
            field: "value",
            operator: "contains",
            value: JSON.stringify(clientId),
          },
        ],
      });
    expect(await issuedCodes()).toBe(0);
    const storedClient = await context.adapter.findOne<
      SchemaClient<readonly string[]>
    >({
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
    });
    expect(storedClient?.tokenEndpointAuthMethod).toBe(
      scenario.tokenEndpointAuthMethod,
    );
    expect(Boolean(storedClient?.clientSecret)).toBe(
      scenario.clientKind === "dcrConfidential",
    );
    if (scenario.clientKind === "cimdPublic") {
      expect(metadataRequestsByUrl.get(clientId)).toBe(1);
    }

    const firstRedirect = await consentAndReadRedirect(browser, firstPage);
    expect(firstRedirect.searchParams.get("code"), firstRedirect.href).toEqual(
      expect.any(String),
    );
    expect(await issuedCodes()).toBe(1);
    expect(firstRedirect.origin + firstRedirect.pathname).toBe(
      new URL(scenario.redirectUri).origin +
        new URL(scenario.redirectUri).pathname,
    );
    const savedConsent = await context.adapter.findOne<
      OAuthConsent<readonly string[]>
    >({
      model: "oauthConsent",
      where: [
        { field: "clientId", value: clientId },
        { field: "userId", value: browser.userId },
      ],
    });
    expect(savedConsent?.scopes).toEqual(["openid"]);

    // The accepted consent is now present for the same browser and scope.
    const requiresFreshConsent =
      REPEAT_BEHAVIOR[scenario.clientKind][scenario.redirectKind] === "consent";
    const secondPage = await authorize({
      browser,
      clientId,
      method,
      redirectUri: scenario.redirectUri,
    });
    expect(await issuedCodes()).toBe(requiresFreshConsent ? 1 : 2);
    if (requiresFreshConsent) {
      expect(secondPage.pathname).toBe("/consent");
      expect(secondPage.searchParams.has("code")).toBe(false);
      expect(
        new URLSearchParams(readSignedQuery(secondPage)).get("prompt"),
      ).toBe("consent");
      const secondRedirect = await consentAndReadRedirect(browser, secondPage);
      expect(secondRedirect.searchParams.get("code")).toEqual(
        expect.any(String),
      );

      const noPromptPage = await authorize({
        browser,
        clientId,
        method,
        prompt: "none",
        redirectUri: scenario.redirectUri,
      });
      expect(noPromptPage.pathname).toBe(
        new URL(scenario.redirectUri).pathname,
      );
      expect(noPromptPage.searchParams.has("code")).toBe(false);
      expect(noPromptPage.searchParams.get("error")).toBe(
        "interaction_required",
      );
      expect(await issuedCodes()).toBe(2);
    } else {
      expect(secondPage.searchParams.get("code")).toEqual(expect.any(String));
      expect(secondPage.pathname).not.toBe("/consent");
    }
  });
});
