import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { session } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  properties,
  workspaceMembers,
  folioCollabRooms,
  folioCollabRoomTokens,
  syntheticSessionControl,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import { authCookiePolicy } from "@/api/lib/auth/auth-cookie-name";
import { createReviewAccountPlugin } from "@/api/lib/auth/review-account-plugin";
import {
  createSessionLifetime,
  SESSION_LIFETIME_FIELDS,
} from "@/api/lib/auth/session-lifetime";
import { createDatabaseSessionLifetimeStore } from "@/api/lib/auth/session-lifetime-store";
import { createSafeId } from "@/api/lib/branded-types";
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
import { authorizeSyntheticSession } from "./session-authority";
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
  const issued = await testDb.transaction(
    async (tx) =>
      await issueFolioCollabToken({
        sourceSessionId: source.id,
        authorityDb: asTestRaw(tx),
        generation: 0,
        permissions: { canEdit: true },
        roomId,
        tx: asTestRaw(tx),
        userId: brandPersistedUserId(SYNTHETIC_PRINCIPAL.user.id),
        workspaceId,
      }),
  );
  expect(issued.tokenExpiresAt).toEqual(source.expiresAt);
  const authorizeRoom = async () =>
    await authorizeFolioCollabRoom({
      roomId,
      token: issued.token,
      db: asTestRaw(testDb),
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
    session: async () => {
      expect(await authorizeSyntheticSession(asTestRaw(testDb), source)).toBe(
        false,
      );
    },
    cookieCache: async () => {
      expect(await authorizeSyntheticSession(asTestRaw(testDb), source)).toBe(
        false,
      );
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
    Extract<
      keyof typeof USER_SESSION_CREDENTIAL_ISSUERS,
      | "session"
      | "cookieCache"
      | "collabRoom"
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
