import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { buildCallbackMessage } from "@/lib/oauth/authorize";
import {
  createGrantStore,
  type KeyValueStorage,
} from "@/lib/oauth/grant-store";
import {
  createOutlookAuth,
  type OpenSignInDialog,
  type PreparedSignIn,
} from "@/lib/outlook-auth";

const API = "https://api.example.test";
const TASK_PANE = "https://outlook.example.test";
const ISSUER = `${API}/api/auth`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth2/token`;
const REVOCATION_ENDPOINT = `${ISSUER}/oauth2/revoke`;
const CLIENT_ID = `${API}/v1/mcp/oauth/outlook-client-metadata.json`;

const METADATA = {
  authorization_endpoint: `${ISSUER}/oauth2/authorize`,
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: true,
  code_challenge_methods_supported: ["S256"],
  issuer: ISSUER,
  revocation_endpoint: REVOCATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
};

type Recorded = { body: string; url: string };

const memoryStorage = (): KeyValueStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

/** A stella authorization server that rotates refresh tokens. */
const fakeServer = () => {
  const requests: Recorded[] = [];
  let issued = 0;
  let refreshRefusal: Response | null = null;
  const fetch = async (input: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ body, url: input });
    if (input === `${API}/.well-known/oauth-authorization-server`) {
      return Response.json(METADATA);
    }
    if (input === TOKEN_ENDPOINT) {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token" && refreshRefusal) {
        return refreshRefusal;
      }
      issued += 1;
      return Response.json({
        access_token: `access-${issued}`,
        expires_in: 3600,
        refresh_token: `refresh-${issued}`,
        token_type: "Bearer",
      });
    }
    if (input === REVOCATION_ENDPOINT) {
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  return {
    fetch,
    refuseRefresh: (response: Response) => {
      refreshRefusal = response;
    },
    requests,
  };
};

/** The dialog as the authorization server would answer it. */
const approvingDialog =
  (answer: (state: string) => string): OpenSignInDialog =>
  async ({ startUrl }) => {
    const authorize = new URL(
      new URL(startUrl).searchParams.get("authorize") ?? "",
    );
    const state = authorize.searchParams.get("state") ?? "";
    return await Promise.resolve({
      message: buildCallbackMessage(
        `${TASK_PANE}/auth/callback.html?${answer(state)}`,
      ),
      origin: TASK_PANE,
    });
  };

const approve = (state: string) =>
  `code=code-1&state=${state}&iss=${encodeURIComponent(ISSUER)}`;

const setup = ({
  openDialog = approvingDialog(approve),
  storage = memoryStorage(),
}: {
  openDialog?: OpenSignInDialog;
  storage?: KeyValueStorage;
} = {}) => {
  const server = fakeServer();
  let clock = 1_000_000;
  const grantStore = createGrantStore({ partitionKey: undefined, storage });
  const auth = createOutlookAuth({
    apiOrigin: API,
    fetch: server.fetch,
    grantStore,
    now: () => clock,
    openDialog,
    policy: { allowLoopbackHttp: false },
    taskPaneOrigin: TASK_PANE,
  });
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    auth,
    grantStore,
    server,
    storage,
  };
};

const prepared = async (
  auth: ReturnType<typeof setup>["auth"],
): Promise<PreparedSignIn> => {
  const result = await auth.prepareSignIn();
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

const tokenRequests = (requests: Recorded[]) =>
  requests
    .filter((request) => request.url === TOKEN_ENDPOINT)
    .map((request) => Object.fromEntries(new URLSearchParams(request.body)));

describe("Outlook sign-in", () => {
  test("exchanges the code with the attempt's verifier and keeps the grant", async () => {
    const { auth, grantStore, server } = setup();
    const attempt = await prepared(auth);

    expect(attempt.clientId).toBe(CLIENT_ID);
    expect(attempt.redirectUri).toBe(`${TASK_PANE}/auth/callback.html`);
    expect(attempt.resource).toBe(`${API}/v1`);

    const signedIn = await auth.signIn(attempt, { promptBeforeOpen: false });

    expect(Result.isOk(signedIn)).toBe(true);
    expect(auth.getStatus()).toBe("signed-in");
    expect(tokenRequests(server.requests)).toEqual([
      {
        client_id: CLIENT_ID,
        code: "code-1",
        code_verifier: attempt.pkce.codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: `${TASK_PANE}/auth/callback.html`,
        resource: `${API}/v1`,
      },
    ]);
    expect(grantStore.read()?.refreshToken).toBe("refresh-1");
    expect(await auth.getAccessToken()).toBe("access-1");
  });

  test("redeems nothing when the answer belongs to another attempt", async () => {
    const { auth, server } = setup({
      openDialog: approvingDialog(() => approve("forged-state")),
    });

    const signedIn = await auth.signIn(await prepared(auth), {
      promptBeforeOpen: false,
    });

    expect(Result.isError(signedIn) ? signedIn.error.failure : null).toBe(
      "mismatched",
    );
    expect(tokenRequests(server.requests)).toEqual([]);
    expect(auth.getStatus()).toBe("signed-out");
  });

  test("reports a refused consent", async () => {
    const { auth } = setup({
      openDialog: approvingDialog(
        (state) =>
          `error=access_denied&state=${state}&iss=${encodeURIComponent(ISSUER)}`,
      ),
    });

    const signedIn = await auth.signIn(await prepared(auth), {
      promptBeforeOpen: false,
    });

    expect(Result.isError(signedIn) ? signedIn.error.failure : null).toBe(
      "denied",
    );
  });
});

describe("Outlook session", () => {
  test("refreshes an expiring token and keeps the rotated refresh token", async () => {
    const { advance, auth, grantStore, server } = setup();
    await auth.signIn(await prepared(auth), { promptBeforeOpen: false });

    advance(3600 * 1000);
    const [first, second] = await Promise.all([
      auth.getAccessToken(),
      auth.getAccessToken(),
    ]);

    expect(first).toBe("access-2");
    expect(second).toBe("access-2");
    expect(tokenRequests(server.requests).at(-1)).toEqual({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      resource: `${API}/v1`,
    });
    expect(tokenRequests(server.requests)).toHaveLength(2);
    expect(grantStore.read()?.refreshToken).toBe("refresh-2");
  });

  test("resumes from the stored grant after a reload", async () => {
    const storage = memoryStorage();
    const first = setup({ storage });
    await first.auth.signIn(await prepared(first.auth), {
      promptBeforeOpen: false,
    });

    const reloaded = setup({ storage });

    expect(reloaded.auth.getStatus()).toBe("signed-in");
    expect(await reloaded.auth.getAccessToken()).toBe("access-1");
    expect(tokenRequests(reloaded.server.requests)[0]?.["refresh_token"]).toBe(
      "refresh-1",
    );
  });

  test("signs out when the grant is gone", async () => {
    const { advance, auth, grantStore, server } = setup();
    await auth.signIn(await prepared(auth), { promptBeforeOpen: false });
    server.refuseRefresh(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );

    advance(3600 * 1000);

    expect(await auth.getAccessToken()).toBeNull();
    expect(auth.getStatus()).toBe("signed-out");
    expect(grantStore.read()).toBeNull();
  });

  test("keeps the grant when the token endpoint is unreachable", async () => {
    const { advance, auth, grantStore, server } = setup();
    await auth.signIn(await prepared(auth), { promptBeforeOpen: false });
    server.refuseRefresh(new Response("unavailable", { status: 503 }));

    advance(3600 * 1000);

    const refreshed = await Result.tryPromise(auth.getAccessToken);
    expect(Result.isError(refreshed)).toBe(true);
    expect(auth.getStatus()).toBe("signed-in");
    expect(grantStore.read()?.refreshToken).toBe("refresh-1");
  });

  test("refreshes once after the API refuses a token", async () => {
    const { auth } = setup();
    await auth.signIn(await prepared(auth), { promptBeforeOpen: false });

    const [first, second] = await Promise.all([
      auth.refreshAfterUnauthorized("access-1"),
      auth.refreshAfterUnauthorized("access-1"),
    ]);

    expect(first).toBe("access-2");
    expect(second).toBe("access-2");
    expect(await auth.refreshAfterUnauthorized("access-1")).toBe("access-2");
  });

  test("revokes the refresh token on sign-out", async () => {
    const { auth, grantStore, server } = setup();
    await auth.signIn(await prepared(auth), { promptBeforeOpen: false });

    await auth.signOut();

    const revocation = server.requests.find(
      (request) => request.url === REVOCATION_ENDPOINT,
    );
    expect(Object.fromEntries(new URLSearchParams(revocation?.body))).toEqual({
      client_id: CLIENT_ID,
      token: "refresh-1",
      token_type_hint: "refresh_token",
    });
    expect(auth.getStatus()).toBe("signed-out");
    expect(grantStore.read()).toBeNull();
    expect(await auth.getAccessToken()).toBeNull();
  });
});
