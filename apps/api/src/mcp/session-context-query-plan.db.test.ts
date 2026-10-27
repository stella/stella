import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  type Mock,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import * as v from "valibot";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import { rlsDb, rootDb } from "@/api/db/root";
import { apiKeysRoute } from "@/api/handlers/api-keys/routes";
import { getAuth } from "@/api/lib/auth";
import {
  getAuthEndpointUrl,
  getAuthIssuerUrl,
} from "@/api/lib/auth/auth-paths";
import { toSafeId } from "@/api/lib/branded-types";
import {
  queryCountLogger,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import { mintAgentRunToken } from "@/api/mcp/agent-run-token";
import { resolveMachineApiKeySession } from "@/api/mcp/api-key-auth";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import type { McpCredentialType, McpSession } from "@/api/mcp/auth";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  grantOAuthClient,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";

const routeServer = serveRoutesForTest(apiKeysRoute);
afterAll(async () => {
  await routeServer.stop();
});

/**
 * Every MCP HTTP request authenticates its bearer credential and then builds
 * the session context (`resolveMcpSessionContext`) before the method runs, so
 * these statements are paid by every `tools/list` and every `tools/call`. The
 * plan is pinned per credential type, enumerated from `McpCredentialType`: a
 * new credential type does not compile until its plan is decided here.
 *
 * Authentication:
 *  - JWT credentials (OAuth client, delegated user, agent run) verify locally
 *    against the cached signing keys: no statement and no key fetch.
 *  - A machine API key reads its key row, records the request on it (two
 *    updates, the plugin's request counter and timestamp), and reads the
 *    owner's membership (4).
 *  - A personal API key additionally reads the organization's personal key
 *    policy (5).
 *
 * Context, for every credential: the membership read, which also carries the
 * feature-access facts (1), then one scoped transaction, a `set_config` plus
 * the authorized workspaces (2). An OAuth client token also looks up its
 * agent registration (1).
 *
 * The organization's reachable business registries are not part of the
 * context: the first projection in a request that offers the registry tool
 * reads them in one scoped transaction (`set_config`, settings, stored
 * credentials: 3), and a second use within the same request reads nothing.
 */
const CONTEXT_TRANSACTIONS = 1;
const CONTEXT_STATEMENTS = 1 + CONTEXT_TRANSACTIONS * 2;
const AGENT_REGISTRATION_READ = 1;
const MACHINE_KEY_STATEMENTS = 4;
const PERSONAL_POLICY_READ = 1;
const REGISTRY_LOAD = { statements: 3, transactions: 1 } as const;
// One scoped settings read; a fixture org stores no key to decrypt.
const WEB_SEARCH_LOAD = { statements: 2, transactions: 1 } as const;

type QueryPlan = {
  authenticate: number;
  context: number;
  contextTransactions: number;
};

const QUERY_PLAN = {
  oauth_client: {
    authenticate: 0,
    context: CONTEXT_STATEMENTS + AGENT_REGISTRATION_READ,
    contextTransactions: CONTEXT_TRANSACTIONS,
  },
  delegated_user: {
    authenticate: 0,
    context: CONTEXT_STATEMENTS,
    contextTransactions: CONTEXT_TRANSACTIONS,
  },
  agent_run: {
    authenticate: 0,
    context: CONTEXT_STATEMENTS,
    contextTransactions: CONTEXT_TRANSACTIONS,
  },
  machine_api_key: {
    authenticate: MACHINE_KEY_STATEMENTS,
    context: CONTEXT_STATEMENTS,
    contextTransactions: CONTEXT_TRANSACTIONS,
  },
  personal_api_key: {
    authenticate: MACHINE_KEY_STATEMENTS + PERSONAL_POLICY_READ,
    context: CONTEXT_STATEMENTS,
    contextTransactions: CONTEXT_TRANSACTIONS,
  },
} as const satisfies Record<McpCredentialType, QueryPlan>;

const isCredentialType = (type: string): type is McpCredentialType =>
  type in QUERY_PLAN;
const CREDENTIAL_TYPES = Object.keys(QUERY_PLAN).filter(isCredentialType);

setDefaultTimeout(120_000);

const BASE = "http://localhost";

let transactions = 0;
let signingKeyFetches = 0;

// The verifier loads the signing keys over HTTP; serve that one address from
// the real auth handler so the token path runs unchanged, and count it.
const passThroughFetch = globalThis.fetch;
let fetchSpy: Mock<typeof globalThis.fetch>;
let serveJwks: typeof fetch;

/** Count every transaction one database boundary opens. */
const countTransactions = (
  database: object,
  open: (...args: never[]) => Promise<unknown>,
) => {
  Object.defineProperty(database, "transaction", {
    configurable: true,
    value: async (...args: never[]) => {
      transactions += 1;
      return await open(...args);
    },
  });
};

beforeAll(async () => {
  await initAgentAuthTestDb({ logger: queryCountLogger });
  // Every transaction opens through one of these two boundaries.
  countTransactions(rootDb, rootDb.transaction.bind(rootDb));
  countTransactions(rlsDb, rlsDb.transaction.bind(rlsDb));
  const jwksUrl = getAuthEndpointUrl("jwks");
  serveJwks = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
      if (request.url === jwksUrl) {
        signingKeyFetches += 1;
        return await getAuth().handler(request);
      }
      return await passThroughFetch(input, init);
    },
    { preconnect: passThroughFetch.preconnect },
  );
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await releaseAgentAuthTestDb();
});

const createdKeySchema = v.looseObject({ key: v.string() });

const postJson = async (
  path: string,
  browser: HumanBrowser,
  body: Record<string, unknown>,
) => {
  const response = await routeServer.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: browser.cookieHeader(),
      },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const created: unknown = await response.json();
  return created;
};

const signDelegatedUserToken = async (
  userId: string,
  organizationId: string,
): Promise<string> => {
  const nowSeconds = Math.floor(
    Temporal.Now.instant().epochMilliseconds / 1000,
  );
  const { token } = await getAuth().api.signJWT({
    body: {
      payload: {
        sub: userId,
        org_id: organizationId,
        scope: MCP_DEFAULT_RESOURCE_SCOPES.join(" "),
        aud: getMcpResourceUrl(),
        iss: getAuthIssuerUrl(),
        iat: nowSeconds,
        exp: nowSeconds + 600,
      },
    },
  });
  return token;
};

type Measured = QueryPlan & {
  signingKeyFetches: number;
  registryLoad: { statements: number; transactions: number };
  registryReload: number;
  webSearchLoad: { statements: number; transactions: number };
  webSearchReload: number;
};

const measure = async (credential: string): Promise<Measured> => {
  const keyFetchesBefore = signingKeyFetches;
  const { session, authenticate } = await runWithQueryCounter(
    async (counter) => {
      const authenticated = await authenticateMcpRequest(credential, {
        resolveApiKeySession: resolveMachineApiKeySession,
      });
      return {
        session: authenticated.unwrap(),
        authenticate: counter.count,
      };
    },
  );
  const transactionsBefore = transactions;
  const { context, requestContext } = await runWithQueryCounter(
    async (counter) => {
      const resolved = await resolveMcpSessionContext(session, {
        request: new Request(`${BASE}/mcp`, { method: "POST" }),
      });
      return { context: counter.count, requestContext: resolved };
    },
  );
  const contextTransactions = transactions - transactionsBefore;
  const registryTransactionsBefore = transactions;
  const registryLoad = await runWithQueryCounter(async (counter) => {
    await requestContext.loadEnabledRegistrySlugs?.();
    return counter.count;
  });
  const registryTransactions = transactions - registryTransactionsBefore;
  const registryReload = await runWithQueryCounter(async (counter) => {
    await requestContext.loadEnabledRegistrySlugs?.();
    return counter.count;
  });
  const webSearchTransactionsBefore = transactions;
  const webSearchLoad = await runWithQueryCounter(async (counter) => {
    await requestContext.loadWebSearchProvider?.();
    return counter.count;
  });
  const webSearchTransactions = transactions - webSearchTransactionsBefore;
  const webSearchReload = await runWithQueryCounter(async (counter) => {
    await requestContext.loadWebSearchProvider?.();
    return counter.count;
  });
  return {
    authenticate,
    context,
    contextTransactions,
    signingKeyFetches: signingKeyFetches - keyFetchesBefore,
    registryLoad: {
      statements: registryLoad,
      transactions: registryTransactions,
    },
    registryReload,
    webSearchLoad: {
      statements: webSearchLoad,
      transactions: webSearchTransactions,
    },
    webSearchReload,
  };
};

const credentialTypeOf = async (credential: string) => {
  const authenticated = await authenticateMcpRequest(credential, {
    resolveApiKeySession: resolveMachineApiKeySession,
  });
  return Result.isOk(authenticated)
    ? (authenticated.value satisfies McpSession).credential?.type
    : undefined;
};

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(serveJwks);
});

afterEach(() => {
  mock.restore();
});

describe("MCP request authentication and session context run a fixed query plan", () => {
  test("each credential type issues its pinned statements on every request", async () => {
    const auth = getAuth();
    const owner = await signInHuman(`owner-${Bun.randomUUIDv7()}@stella.dev`);
    const organization = await auth.api.createOrganization({
      body: {
        name: "MCP query plan",
        slug: `mcp-query-plan-${Bun.randomUUIDv7()}`,
      },
      headers: owner.headers(),
    });
    await owner.setActiveOrganization(organization.id);

    const oauthGrant = await grantOAuthClient(
      owner,
      await registerOAuthClient(),
    );
    const machineKey = v.parse(
      createdKeySchema,
      await postJson("/api-keys", owner, {
        name: "CI",
        scopes: ["stella:read"],
        permissions: { workspace: ["read"] },
      }),
    ).key;
    await postJson("/api-keys/personal/policy", owner, { policy: "enabled" });
    const personalKey = v.parse(
      createdKeySchema,
      await postJson("/api-keys/personal", owner, { name: "Laptop" }),
    ).key;
    const agentRun = await mintAgentRunToken({
      userId: toSafeId<"user">(owner.userId),
      organizationId: toSafeId<"organization">(organization.id),
      runId: Bun.randomUUIDv7(),
      workspaceIds: [],
    });

    const credentials = {
      oauth_client: oauthGrant.accessToken,
      delegated_user: await signDelegatedUserToken(
        owner.userId,
        organization.id,
      ),
      agent_run: agentRun.token,
      machine_api_key: machineKey,
      personal_api_key: personalKey,
    } as const satisfies Record<McpCredentialType, string>;

    for (const type of CREDENTIAL_TYPES) {
      const credential = credentials[type];
      // Each fixture authenticates as the type it stands for, or the plan
      // below would be measured against the wrong path.
      expect(await credentialTypeOf(credential)).toBe(type);

      // The first request may load the signing keys; every later one is the
      // steady state, and two of them must agree.
      await measure(credential);
      const steady = await measure(credential);
      expect({ type, ...steady }).toEqual({
        type,
        ...QUERY_PLAN[type],
        signingKeyFetches: 0,
        registryLoad: REGISTRY_LOAD,
        registryReload: 0,
        webSearchLoad: WEB_SEARCH_LOAD,
        webSearchReload: 0,
      });
      expect(await measure(credential)).toEqual(steady);
    }
  });
});
