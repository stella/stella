import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import Elysia from "elysia";
import { randomBytes } from "node:crypto";
import * as v from "valibot";

import {
  DESKTOP_ACCOUNT_POLICY,
  DESKTOP_ACCOUNT_PROTOCOL_HEADER,
} from "@stll/api-contract/desktop-registry";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import {
  desktopEditSessions,
  entities,
  entityVersions,
  folioCollabRooms,
  pdfSigningSessions,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { apiKeysRoute } from "@/api/handlers/api-keys/routes";
import { desktopRegistryRoute } from "@/api/handlers/desktop-registry/routes";
import {
  createAuthMacro,
  getAuth,
  realtimeAuthorizers,
  sessionAuthMacro,
} from "@/api/lib/auth";
import {
  getAuthEndpointUrl,
  getAuthIssuerUrl,
} from "@/api/lib/auth/auth-paths";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { authorizeDesktopRegistry } from "@/api/lib/business-registries/desktop/auth";
import { createConfirmationOtp } from "@/api/lib/confirmation-otp";
import { verifyAndDeleteUser } from "@/api/lib/delete-account";
import {
  authorizeDesktopEditSession,
  hashDesktopEditSessionToken,
} from "@/api/lib/desktop-edit-sessions";
import {
  authorizePdfSigningSession,
  createPdfSigningToken,
  hashPdfSigningToken,
} from "@/api/lib/files/pdf-signing/sessions";
import {
  authorizeFolioCollabRoom,
  issueFolioCollabToken,
} from "@/api/lib/folio-collab-rooms";
import {
  disconnectOAuthConnectionForUser,
  listOAuthConnectionsForUser,
} from "@/api/lib/oauth-connections";
import { tokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { mintAgentRunToken } from "@/api/mcp/agent-run-token";
import { resolveMachineApiKeySession } from "@/api/mcp/api-key-auth";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { createDesktopDeviceSigner } from "@/api/tests/helpers/desktop-device-proof";
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
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  CREDENTIAL_VERIFIERS,
  OPEN_REVOCATION_DECISIONS,
} from "@/api/tests/security/credential-verifiers";
import type {
  CredentialRevocation,
  CredentialVerifierKind,
} from "@/api/tests/security/credential-verifiers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// For every registered verifier: issue a real credential through the path
// that issues it in production, check the production verifier accepts it,
// apply one revocation, and ask the same verifier again. The next answer is
// a refusal, unless the registry names the pair as an open decision with the
// bound it is accepted for; then this suite proves that bound instead.

setDefaultTimeout(300_000);

const BASE = "http://localhost";

// The MCP verifier loads the signing keys over HTTP; serve that one address
// from the real auth handler so the token path runs unchanged.
const passThroughFetch = globalThis.fetch;
const fetchSpy = spyOn(globalThis, "fetch");

let db: TestDatabase;

beforeAll(async () => {
  db = await initAgentAuthTestDb();
  const jwksUrl = getAuthEndpointUrl("jwks");
  const serveJwks: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
      if (request.url === jwksUrl) {
        return await getAuth().handler(request);
      }
      return await passThroughFetch(input, init);
    },
    { preconnect: passThroughFetch.preconnect },
  );
  fetchSpy.mockImplementation(serveJwks);
});

afterAll(async () => {
  setSystemTime();
  fetchSpy.mockRestore();
  await releaseAgentAuthTestDb();
});

// ── One admitted member, the subject of every scenario ──────────────────

type Admitted = {
  owner: HumanBrowser;
  member: HumanBrowser;
  email: string;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  matter: SeededMatter;
};

type SeededMatter = {
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
};

const seedMatter = async (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
): Promise<SeededMatter> => {
  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Revocation matter",
    reference: workspaceId,
  });
  await db.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId,
  });
  await db
    .insert(entities)
    .values({ id: entityId, workspaceId, kind: "document", name: "Document" });
  await db
    .insert(entityVersions)
    .values({ id: versionId, workspaceId, entityId });
  return { workspaceId, entityId, versionId };
};

const seedFileProperty = async (
  workspaceId: SafeId<"workspace">,
): Promise<SafeId<"property">> => {
  const propertyId = createSafeId<"property">();
  await db.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: `File ${propertyId}`,
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  return propertyId;
};

const admitMember = async (): Promise<Admitted> => {
  const auth = getAuth();
  const owner = await signInHuman(`owner-${Bun.randomUUIDv7()}@stella.dev`);
  const organization = await auth.api.createOrganization({
    body: {
      name: "Credential revocation",
      slug: `credential-revocation-${Bun.randomUUIDv7()}`,
    },
    headers: owner.headers(),
  });
  await owner.setActiveOrganization(organization.id);

  const email = `member-${Bun.randomUUIDv7()}@stella.dev`;
  const member = await signInHuman(email);
  const invitation = await auth.api.createInvitation({
    body: { email, role: "admin", organizationId: organization.id },
    headers: owner.headers(),
  });
  await auth.api.acceptInvitation({
    body: { invitationId: invitation.id },
    headers: member.headers(),
  });
  await member.setActiveOrganization(organization.id);

  const userId = toSafeId<"user">(member.userId);
  const organizationId = toSafeId<"organization">(organization.id);
  return {
    owner,
    member,
    email,
    userId,
    organizationId,
    matter: await seedMatter(organizationId, userId),
  };
};

// ── Revocations, each through the path a person takes ───────────────────

const REVOKE = {
  memberRemoved: async ({ owner, email, organizationId }) => {
    await getAuth().api.removeMember({
      body: { memberIdOrEmail: email, organizationId },
      headers: owner.headers(),
    });
  },
  accountDeleted: async ({ email, userId }) => {
    const code = await createConfirmationOtp({
      purpose: "delete-account",
      email,
    });
    if (Result.isError(code)) {
      panic(code.error.message);
    }
    const deleted = await verifyAndDeleteUser(userId, email, code.value);
    if (Result.isError(deleted)) {
      panic(deleted.error.message);
    }
  },
  sessionRevoked: async ({ email }) => {
    // Signed in on a second device, the person signs every other one out.
    const otherDevice = await signInHuman(email);
    await getAuth().api.revokeOtherSessions({ headers: otherDevice.headers() });
  },
  grantRevoked: async ({ userId }) => {
    const connections = await listOAuthConnectionsForUser(userId);
    if (Result.isError(connections)) {
      panic(connections.error.message);
    }
    expect(connections.value.length).toBeGreaterThan(0);
    for (const connection of connections.value) {
      const disconnected = await disconnectOAuthConnectionForUser(
        userId,
        connection.id,
      );
      if (Result.isError(disconnected)) {
        panic(disconnected.error.message);
      }
    }
  },
} as const satisfies Record<
  CredentialRevocation,
  (admitted: Admitted) => Promise<void>
>;

// ── Credentials and the verifier that accepts each ──────────────────────

/** Ask the production verifier whether the credential is accepted now. */
type Verify = () => Promise<boolean>;
type Issue = (admitted: Admitted) => Promise<Verify>;

const probeRoute =
  (
    app: { handle: (request: Request) => Response | Promise<Response> },
    headers: Record<string, string>,
  ): Verify =>
  async () =>
    (await app.handle(new Request(`${BASE}/probe`, { headers }))).status ===
    200;

const organizationRoute = new Elysia()
  .use(createAuthMacro())
  .get("/probe", () => "ok", { validateAuth: true });

const accountRoute = new Elysia()
  .use(sessionAuthMacro)
  .get("/probe", () => "ok", { validateSession: true });

/** The signed session token a desktop or extension presents as a bearer. */
const signedSessionToken = (browser: HumanBrowser): string => {
  const pair = browser
    .cookieHeader()
    .split("; ")
    .find((part) => part.split("=").at(0)?.endsWith(".session_token"));
  const value = pair?.slice(pair.indexOf("=") + 1);
  if (!value) {
    panic("The browser holds no session token");
  }
  return decodeURIComponent(value);
};

/** Whether a bearer token opens an MCP request context. */
const opensMcpContext = async (token: string): Promise<boolean> => {
  const session = await authenticateMcpRequest(token);
  if (session.isErr()) {
    return false;
  }
  const context = await Result.tryPromise(
    async () =>
      await resolveMcpSessionContext(session.value, {
        request: new Request(`${BASE}/mcp`, { method: "POST" }),
      }),
  );
  return context.isOk();
};

const createdKeySchema = v.looseObject({ key: v.string() });

const postAsBrowser = async (
  route: { handle: (request: Request) => Promise<Response> },
  path: string,
  browser: HumanBrowser,
  body: Record<string, unknown>,
) =>
  await route.handle(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: browser.cookieHeader(),
      },
      body: JSON.stringify(body),
    }),
  );

const readCreatedKey = async (response: Response): Promise<string> => {
  expect(response.status, await response.clone().text()).toBe(200);
  return v.parse(createdKeySchema, await response.json()).key;
};

const issueDesktopAccountKey: Issue = async ({ member, organizationId }) => {
  const device = await createDesktopDeviceSigner();
  const correlationId = Bun.randomUUIDv7();
  const verifier = randomBytes(32).toString("hex");
  const grant = await postAsBrowser(
    desktopRegistryRoute,
    "/desktop-registry/grant",
    member,
    {
      correlationId,
      deviceJkt: device.deviceJkt,
      verifierHash: hashSha256Hex(verifier),
    },
  );
  expect(grant.status, await grant.clone().text()).toBe(200);
  const redeemed = await desktopRegistryRoute.handle(
    await device.signRequest({
      request: new Request(`${BASE}/desktop-registry/redeem-link`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [DESKTOP_ACCOUNT_PROTOCOL_HEADER]: String(
            DESKTOP_ACCOUNT_POLICY.linkProtocol,
          ),
        },
        body: JSON.stringify({
          correlationId,
          deviceJkt: device.deviceJkt,
          verifier,
          expectedUserId: member.userId,
          expectedOrganizationId: organizationId,
        }),
      }),
      nonce: correlationId,
    }),
  );
  const key = await readCreatedKey(redeemed);
  return async () =>
    (
      await authorizeDesktopRegistry(
        await device.signRequest({
          request: new Request(`${BASE}/desktop-registry/request`, {
            method: "POST",
            headers: { authorization: `Bearer ${key}` },
          }),
          credential: key,
        }),
      )
    ).isOk();
};

const noSessionAuthority = async () => await Promise.resolve(null);

const issueCollabRoomToken: Issue = async ({ userId, matter }) => {
  const propertyId = await seedFileProperty(matter.workspaceId);
  const roomId = createSafeId<"folioCollabRoom">();
  await db.insert(folioCollabRooms).values({
    id: roomId,
    entityId: matter.entityId,
    propertyId,
    baseVersionId: matter.versionId,
    sourceVersionId: matter.versionId,
    docxCheckpointFileId: createSafeId<"userFile">(),
    yjsSnapshotFileId: createSafeId<"userFile">(),
    fileName: "document.docx",
    generation: 0,
    seedState: "empty",
    workspaceId: matter.workspaceId,
  });
  const issued = await issueFolioCollabToken({
    sourceSessionId: null,
    readSessionAuthority: noSessionAuthority,
    generation: 0,
    permissions: { canEdit: true },
    roomId,
    tx: asTestRaw(db),
    userId,
    workspaceId: matter.workspaceId,
  });
  return async () =>
    (
      await authorizeFolioCollabRoom({
        roomId,
        token: issued.token,
        readSessionAuthority: noSessionAuthority,
      })
    ).status === "authorized";
};

const issueDesktopEditSessionToken: Issue = async ({ userId, matter }) => {
  const sessionId = createSafeId<"desktopEditSession">();
  const sessionToken = randomBytes(32).toString("hex");
  await db.insert(desktopEditSessions).values({
    id: sessionId,
    workspaceId: matter.workspaceId,
    entityId: matter.entityId,
    propertyId: await seedFileProperty(matter.workspaceId),
    baseVersionId: matter.versionId,
    createdBy: userId,
    status: "open",
    fileType: "docx",
    fileName: "desktop.docx",
    checkpointFileId: createSafeId<"userFile">(),
    sessionTokenHash: hashDesktopEditSessionToken(sessionToken),
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return async () =>
    (await authorizeDesktopEditSession({ sessionId, sessionToken })).status ===
    "authorized";
};

const issuePdfSigningSessionToken: Issue = async ({ userId, matter }) => {
  const sessionId = createSafeId<"pdfSigningSession">();
  const sessionToken = createPdfSigningToken({ userId });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.insert(pdfSigningSessions).values({
    id: sessionId,
    workspaceId: matter.workspaceId,
    entityId: matter.entityId,
    propertyId: await seedFileProperty(matter.workspaceId),
    baseVersionId: matter.versionId,
    createdBy: userId,
    handoffTokenHash: hashPdfSigningToken(createPdfSigningToken({ userId })),
    handoffExpiresAt: expiresAt,
    handoffConsumedAt: new Date(),
    sessionTokenHash: hashPdfSigningToken(sessionToken),
    tokenExpiresAt: expiresAt,
  });
  return async () =>
    (
      await authorizePdfSigningSession(
        { sessionId, sessionToken },
        tokenScopedDatabase,
      )
    ).status === "authorized";
};

/** Token claims for a user token issued to no client. */
const signDelegatedUserToken = async ({
  userId,
  organizationId,
}: Admitted): Promise<string> => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { token } = await getAuth().api.signJWT({
    body: {
      payload: {
        sub: userId,
        org_id: organizationId,
        scope: "stella:read",
        aud: getMcpResourceUrl(),
        iss: getAuthIssuerUrl(),
        iat: nowSeconds,
        exp: nowSeconds + 15 * 60,
      },
    },
  });
  return token;
};

type DrivenVerifierKind = Exclude<
  CredentialVerifierKind,
  "inboundMailSender" | "signedObjectUrl"
>;

const ISSUE = {
  browserSession:
    async ({ member }) =>
    async () =>
      await probeRoute(organizationRoute, { cookie: member.cookieHeader() })(),
  accountSession:
    async ({ member }) =>
    async () =>
      await probeRoute(accountRoute, { cookie: member.cookieHeader() })(),
  bearerSession: async ({ member }) => {
    const token = signedSessionToken(member);
    return probeRoute(organizationRoute, { authorization: `Bearer ${token}` });
  },
  mcpAccessToken: async ({ member }) => {
    const grant = await grantOAuthClient(member, await registerOAuthClient());
    return async () => await opensMcpContext(grant.accessToken);
  },
  agentRunToken: async ({ userId, organizationId, matter }) => {
    const { token } = await mintAgentRunToken({
      userId,
      organizationId,
      runId: Bun.randomUUIDv7(),
      workspaceIds: [matter.workspaceId],
    });
    return async () => await opensMcpContext(token);
  },
  delegatedUserToken: async (admitted) => {
    const token = await signDelegatedUserToken(admitted);
    return async () => await opensMcpContext(token);
  },
  apiKey: async ({ member }) => {
    const key = await readCreatedKey(
      await postAsBrowser(apiKeysRoute, "/api-keys", member, {
        name: "CI",
        scopes: ["stella:read"],
        permissions: { workspace: ["read"] },
      }),
    );
    return async () =>
      (
        await Result.tryPromise(
          async () => await resolveMachineApiKeySession(key),
        )
      ).isOk();
  },
  desktopAccountKey: issueDesktopAccountKey,
  collabRoom: issueCollabRoomToken,
  desktopEditSession: issueDesktopEditSessionToken,
  pdfSigningSession: issuePdfSigningSessionToken,
  realtimeStream:
    async ({ userId, organizationId, matter }) =>
    async () =>
      (await realtimeAuthorizers.user({ organizationId, userId })) &&
      (
        await realtimeAuthorizers.workspace({
          userIds: [userId],
          workspaceId: matter.workspaceId,
        })
      ).has(userId),
} as const satisfies Record<DrivenVerifierKind, Issue>;

const OPEN_DECISIONS: Partial<
  Record<
    CredentialVerifierKind,
    Partial<
      Record<
        CredentialRevocation,
        { readonly acceptedForSeconds: number | null }
      >
    >
  >
> = OPEN_REVOCATION_DECISIONS;

const scenarios = (Object.keys(ISSUE) as DrivenVerifierKind[]).flatMap((kind) =>
  CREDENTIAL_VERIFIERS[kind].revocations.map(
    (revocation) => [kind, revocation] as const,
  ),
);

describe("credential verifiers after a revocation", () => {
  test("every verifier is driven here, proven in its own lane, or decided for every revocation", () => {
    const uncovered = (
      Object.keys(CREDENTIAL_VERIFIERS) as CredentialVerifierKind[]
    ).filter((kind) => {
      const verifier: {
        proof?: unknown;
        revocations: readonly CredentialRevocation[];
      } = CREDENTIAL_VERIFIERS[kind];
      return (
        !Object.hasOwn(ISSUE, kind) &&
        verifier.proof === undefined &&
        !verifier.revocations.every(
          (revocation) => OPEN_DECISIONS[kind]?.[revocation] !== undefined,
        )
      );
    });
    expect(uncovered).toEqual([]);
  });

  test.each(scenarios)(
    "%s refuses the next verification after %s",
    async (kind, revocation) => {
      const admitted = await admitMember();
      const verify = await ISSUE[kind](admitted);
      // The credential has to work first, or the refusal below proves nothing.
      expect(await verify()).toBe(true);

      await REVOKE[revocation](admitted);

      const decision = OPEN_DECISIONS[kind]?.[revocation];
      if (decision === undefined) {
        expect(await verify()).toBe(false);
        return;
      }
      // An open decision: accepted now, refused once its bound has passed.
      expect(await verify()).toBe(true);
      if (decision.acceptedForSeconds === null) {
        return;
      }
      try {
        setSystemTime(
          new Date(Date.now() + (decision.acceptedForSeconds + 1) * 1000),
        );
        expect(await verify()).toBe(false);
      } finally {
        setSystemTime();
      }
    },
  );
});
