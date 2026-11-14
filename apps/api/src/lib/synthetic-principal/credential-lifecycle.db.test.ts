import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { session } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  auditLogs,
  entities,
  entityVersions,
  fields,
  folioCollabRooms,
  folioCollabRoomTokens,
  properties,
  syntheticSessionControl,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import { authCookiePolicy } from "@/api/lib/auth/auth-cookie-name";
import { createReviewAccountPlugin } from "@/api/lib/auth/review-account-plugin";
import {
  createSessionLifetime,
  SESSION_LIFETIME_FIELDS,
} from "@/api/lib/auth/session-lifetime";
import { createDatabaseSessionLifetimeStore } from "@/api/lib/auth/session-lifetime-store";
import { createSafeId } from "@/api/lib/branded-types";
import { readFileHandler } from "@/api/lib/files/read-file";
import {
  authorizeFolioCollabRoom,
  issueFolioCollabToken,
  refreshFolioCollabToken,
} from "@/api/lib/folio-collab-rooms";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  refusedCredentialIssuerProbes,
  syntheticCredentialPrincipal,
} from "@/api/tests/helpers/session-credential-issuer-probes";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import { SYNTHETIC_PRINCIPAL, SYNTHETIC_SESSION_CONTROL_ID } from "./constants";
import type { USER_SESSION_CREDENTIAL_ISSUERS } from "./credential-policy";
import {
  checkSyntheticPrincipalAccess,
  syntheticPrincipalAuthConfig,
} from "./policy";
import {
  authorizeSyntheticSession,
  readSyntheticSessionAuthority,
} from "./session-authority";
import { createSyntheticSessionStore } from "./store";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
beforeAll(async () => {
  fixture = await getRlsFixture();
});
afterAll(async () => {
  await releaseRlsFixture();
});

const setup = async () => {
  const { testDb } = fixture;
  const store = createSyntheticSessionStore(asTestRaw(testDb));
  await store.revokeSyntheticSessions();
  await testDb
    .insert(syntheticSessionControl)
    .values({ id: SYNTHETIC_SESSION_CONTROL_ID, status: "enabled" })
    .onConflictDoUpdate({
      target: syntheticSessionControl.id,
      set: { status: "enabled" },
    });
  const minted = await store.mintSyntheticSession({
    keyLabel: "fixture",
    requestId: undefined,
    userAgent: null,
  });
  if (!minted) {
    panic("Missing monitoring session");
  }
  const [source] = await testDb
    .select()
    .from(session)
    .where(eq(session.userId, SYNTHETIC_PRINCIPAL.user.id));
  if (!source) {
    panic("Missing source session");
  }
  expect(source.expiresAt.getTime() - source.createdAt.getTime()).toBe(
    30 * 60 * 1000,
  );
  // A second live session must not extend a credential's original session.
  await store.mintSyntheticSession({
    keyLabel: "fixture",
    requestId: undefined,
    userAgent: null,
  });
  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  const propertyId = createSafeId<"property">();
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId: brandPersistedOrganizationId(SYNTHETIC_PRINCIPAL.org.id),
    name: "Monitoring",
    reference: workspaceId,
  });
  await testDb.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId: SYNTHETIC_PRINCIPAL.user.id,
  });
  await testDb
    .insert(entities)
    .values({ id: entityId, workspaceId, kind: "document", name: "Document" });
  await testDb
    .insert(entityVersions)
    .values({ id: versionId, workspaceId, entityId });
  await testDb.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "File",
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  const fieldId = createSafeId<"field">();
  const fileId = createSafeId<"userFile">();
  await testDb.insert(fields).values({
    id: fieldId,
    workspaceId,
    propertyId,
    entityVersionId: versionId,
    content: {
      version: 1,
      type: "file",
      id: fileId,
      fileName: "document.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 1024,
      encrypted: false,
      sha256Hex: "a".repeat(64),
      pdfFileId: null,
    },
  });
  const roomId = createSafeId<"folioCollabRoom">();
  await testDb.insert(folioCollabRooms).values({
    id: roomId,
    entityId,
    propertyId,
    baseVersionId: versionId,
    sourceVersionId: versionId,
    docxCheckpointFileId: createSafeId<"userFile">(),
    yjsSnapshotFileId: createSafeId<"userFile">(),
    fileName: "document.docx",
    generation: 0,
    seedState: "empty",
    workspaceId,
  });
  const readSessionAuthority = async (options: {
    sessionId: string | null;
    userId: string;
    now?: Date;
  }) => await readSyntheticSessionAuthority(testDb, options);
  const issued = await issueFolioCollabToken({
    sourceSessionId: source.id,
    readSessionAuthority,
    generation: 0,
    permissions: { canEdit: true },
    roomId,
    tx: asTestRaw(testDb),
    userId: brandPersistedUserId(SYNTHETIC_PRINCIPAL.user.id),
    workspaceId,
  });
  expect(issued.tokenExpiresAt).toEqual(source.expiresAt);
  const authorizeRoom = async () =>
    await authorizeFolioCollabRoom({
      roomId,
      token: issued.token,
      db: asTestRaw(testDb),
      readSessionAuthority,
    });
  const authorized = await authorizeRoom();
  expect(authorized.status).toBe("authorized");
  if (authorized.status !== "authorized") {
    panic("Missing room authorization");
  }
  const renewed = await testDb.transaction(
    async (tx) =>
      await refreshFolioCollabToken({
        tokenId: authorized.value.tokenId,
        tx: asTestRaw(tx),
        sourceSessionExpiresAt: authorized.value.sourceSessionExpiresAt,
      }),
  );
  expect(renewed?.tokenExpiresAt).toEqual(source.expiresAt);

  const scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(
      testDb,
      [workspaceId],
      brandPersistedOrganizationId(SYNTHETIC_PRINCIPAL.org.id),
      brandPersistedUserId(SYNTHETIC_PRINCIPAL.user.id),
    ),
  );
  const recordAuditEvent = createAuditRecorder({
    organizationId: brandPersistedOrganizationId(SYNTHETIC_PRINCIPAL.org.id),
    workspaceId,
    userId: brandPersistedUserId(SYNTHETIC_PRINCIPAL.user.id),
    request: new Request("https://api.example.test/files"),
    server: null,
  });
  const download = async () => {
    // Read the session authority first, then run the handler transaction:
    // the test database serves one operation at a time.
    const authority = await readSessionAuthority({
      sessionId: source.id,
      userId: SYNTHETIC_PRINCIPAL.user.id,
    });
    return await readFileHandler({
      userId: brandPersistedUserId(SYNTHETIC_PRINCIPAL.user.id),
      source: { kind: "request", sessionId: source.id },
      scopedDb,
      fieldId,
      organizationId: brandPersistedOrganizationId(SYNTHETIC_PRINCIPAL.org.id),
      workspaceId,
      purpose: "download",
      recordAuditEvent,
      readSessionAuthority: async () => authority,
    });
  };
  const liveDownload = await download();
  if (!("presignedUrl" in liveDownload)) {
    panic("Missing dedicated session download");
  }
  expect(typeof liveDownload.presignedUrl).toBe("string");
  expect(
    Number(
      new URL(liveDownload.presignedUrl).searchParams.get("X-Amz-Expires"),
    ),
  ).toBeLessThanOrEqual(60);
  expect(
    await testDb
      .select({ resourceId: auditLogs.resourceId })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, entityId)),
  ).toEqual([{ resourceId: entityId }]);

  const lifetime = createSessionLifetime({
    store: createDatabaseSessionLifetimeStore(asTestRaw(testDb), {
      expiresIn: 604_800,
      updateAge: 86_400,
    }),
  });
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(testDb, AUTH_DATABASE_ADAPTER_OPTIONS),
    advanced: authCookiePolicy(),
    session: {
      additionalFields: {
        ...SESSION_LIFETIME_FIELDS,
        activeOrganizationId: { type: "string", required: false },
      },
      cookieCache: {
        enabled: true,
        maxAge: 60,
        version: lifetime.cookieCacheVersion,
      },
    },
    plugins: [
      lifetime.plugin,
      createReviewAccountPlugin({
        config: syntheticPrincipalAuthConfig,
        checkAccess: checkSyntheticPrincipalAccess,
        localPasswordEnabled: true,
        authorizeSession: async (current) =>
          await authorizeSyntheticSession(asTestRaw(testDb), current),
      }),
      organization(),
      apiKey(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        disableJwtPlugin: true,
        resourceSeedMode: "none",
      }),
    ],
  });
  const tokenCookie = `${minted.cookieName}=${minted.cookieValue}`;
  const cached = await auth.api.getSession({
    headers: { cookie: tokenCookie },
    returnHeaders: true,
  });
  expect(cached.response?.session.id).toBe(source.id);
  const cacheCookies = cached.headers
    .getSetCookie()
    .map((value) => value.split(";").at(0))
    .join("; ");
  expect(cacheCookies).toContain("session_data=");
  const cookie = `${tokenCookie}; ${cacheCookies}`;
  const authPost = async (path: string, body: unknown) =>
    await auth.handler(
      new Request(`http://localhost:3001/api/auth${path}`, {
        method: "POST",
        headers: {
          cookie,
          origin: "http://localhost:3001",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  const probes = {
    collabRoom: async () => {
      expect((await authorizeRoom()).status).not.toBe("authorized");
    },
    signedDownload: async () => {
      expect(await rejectionOf(download())).toMatchObject({
        status: 403,
        code: "account_access_unavailable",
      });
    },
    session: async () => {
      expect(await authorizeSyntheticSession(asTestRaw(testDb), source)).toBe(
        false,
      );
    },
    cookieCache: async () => {
      const resolved = await auth.api.getSession({
        headers: { cookie },
      });
      expect(resolved).toBeNull();
    },
    cookie: async () => {
      const resolved = await auth.api.getSession({
        headers: { cookie: tokenCookie },
      });
      expect(resolved).toBeNull();
    },
    bearer: async () => {
      const resolved = await auth.api.getSession({
        headers: { authorization: `Bearer ${minted.cookieValue}` },
      });
      expect(resolved).toBeNull();
    },
    oauth: async () => {
      expect([401, 403]).toContain(
        (await authPost("/oauth2/consent", { accept: true })).status,
      );
    },
    invitation: async () => {
      expect([401, 403]).toContain(
        (
          await authPost("/organization/invite-member", {
            email: "member@example.test",
            organizationId: SYNTHETIC_PRINCIPAL.org.id,
            role: "member",
          })
        ).status,
      );
    },
    apiKey: async () => {
      expect([401, 403]).toContain(
        (
          await authPost("/api-key/create", {
            userId: SYNTHETIC_PRINCIPAL.user.id,
            name: "Fixture",
          })
        ).status,
      );
    },
  } satisfies Record<
    // Session resolution probes, then every credential issuer probed here.
    | "cookie"
    | "bearer"
    | Extract<
        keyof typeof USER_SESSION_CREDENTIAL_ISSUERS,
        | "session"
        | "cookieCache"
        | "collabRoom"
        | "signedDownload"
        | "oauth"
        | "apiKey"
        | "invitation"
      >,
    () => Promise<void>
  >;
  return { store, probes, source, testDb };
};

for (const transition of ["revoked", "expired", "disabled"] as const) {
  test(`session credentials are unavailable when the source is ${transition}`, async () => {
    const { store, probes, source, testDb } = await setup();
    await probes.bearer();
    if (transition === "revoked") {
      const revoked = await store.revokeSyntheticSessions();
      expect(revoked.deletedRoomTokens).toBe(1);
      expect(await testDb.select().from(folioCollabRoomTokens)).toHaveLength(0);
    } else if (transition === "expired") {
      await testDb
        .update(session)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(session.id, source.id));
    } else {
      await testDb
        .update(syntheticSessionControl)
        .set({ status: "revoked" })
        .where(eq(syntheticSessionControl.id, SYNTHETIC_SESSION_CONTROL_ID));
    }
    for (const probe of Object.values(probes)) {
      await probe();
    }
    for (const probe of Object.values(refusedCredentialIssuerProbes)) {
      await probe(syntheticCredentialPrincipal);
    }
  });
}
