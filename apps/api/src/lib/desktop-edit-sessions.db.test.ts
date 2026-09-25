/**
 * Desktop edit session event reads and liveness renewals run in the session's
 * own scope: role `stella`, pinned to the session's workspace, exactly as
 * `authorizeDesktopEditSession` builds it. The policies bound which session
 * rows are reachable; the membership joins and token predicates still decide
 * the answer inside that bound.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  desktopEditSessions,
  properties,
  workspaceMembers,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  hashDesktopEditSessionToken,
  readDesktopEditSessionEventState,
  refreshDesktopEditSessionLiveness,
} from "@/api/lib/desktop-edit-sessions";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

/** Asked for a takeover while a member; has since left the organization. */
const formerRequester = mintAuthProviderId<"user">();
/** Creates a session, then loses the matter membership it depended on. */
const revokedCreator = mintAuthProviderId<"user">();

const createdUsers = [formerRequester, revokedCreator];

type SeededSession = {
  id: SafeId<"desktopEditSession">;
  token: string;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  createdBy: SafeId<"user">;
};

let sessions: Record<
  | "withMemberRequest"
  | "withFormerRequest"
  | "revoked"
  | "expired"
  | "closed"
  | "foreign",
  SeededSession
>;

const hourFromNow = () => new Date(Date.now() + 60 * 60 * 1000);

const seedSession = async ({
  createdBy,
  entityId,
  entityVersionId,
  organizationId,
  status = "open",
  takeoverRequestedBy = null,
  tokenExpiresAt = hourFromNow(),
  workspaceId,
}: {
  createdBy: SafeId<"user">;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  organizationId: SafeId<"organization">;
  status?: "open" | "finalized";
  takeoverRequestedBy?: SafeId<"user"> | null;
  tokenExpiresAt?: Date;
  workspaceId: SafeId<"workspace">;
}): Promise<SeededSession> => {
  const id = createSafeId<"desktopEditSession">();
  const token = Bun.randomUUIDv7().replaceAll("-", "").repeat(2);
  // A file property of its own per session keeps the one-open-session-per-
  // target index out of the way.
  const propertyId = createSafeId<"property">();
  await testDb.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: `Desktop file ${id}`,
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
    status: "fresh",
  });
  await testDb.insert(desktopEditSessions).values({
    id,
    workspaceId,
    entityId,
    propertyId,
    baseVersionId: entityVersionId,
    createdBy,
    status,
    fileType: "docx",
    fileName: "desktop.docx",
    checkpointFileId: createSafeId<"userFile">(),
    sessionTokenHash: hashDesktopEditSessionToken(token),
    tokenExpiresAt,
    takeoverRequestedBy,
    takeoverRequestedAt: takeoverRequestedBy === null ? null : new Date(),
  });
  return { id, token, workspaceId, organizationId, createdBy };
};

/** The scope `authorizeDesktopEditSession` hands a session's stream. */
const sessionScope = async <T>(
  session: SeededSession,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await createScopedDb(
    testDb,
    [session.workspaceId],
    session.organizationId,
    session.createdBy,
  )(async (tx) => await fn(asTestRaw<Transaction>(tx)));

const readTokenExpiry = async (sessionId: SafeId<"desktopEditSession">) =>
  (
    await testDb
      .select({ tokenExpiresAt: desktopEditSessions.tokenExpiresAt })
      .from(desktopEditSessions)
      .where(eq(desktopEditSessions.id, sessionId))
  ).at(0)?.tokenExpiresAt;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  await testDb.insert(user).values([
    {
      id: formerRequester,
      name: "Former requester",
      email: `${formerRequester}@test.local`,
    },
    {
      id: revokedCreator,
      name: "Revoked creator",
      email: `${revokedCreator}@test.local`,
    },
  ]);
  const formerMembershipId = mintAuthProviderIdValue();
  await testDb.insert(member).values([
    {
      id: formerMembershipId,
      organizationId: ids.orgA,
      userId: formerRequester,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: mintAuthProviderIdValue(),
      organizationId: ids.orgA,
      userId: revokedCreator,
      role: "member",
      createdAt: new Date(),
    },
  ]);
  await testDb.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId: ids.wsA1,
    userId: revokedCreator,
  });

  const inWsA2 = {
    createdBy: ids.userA1,
    entityId: ids.entityA2,
    entityVersionId: ids.entityVersionA2,
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
  };
  sessions = {
    withMemberRequest: await seedSession({
      ...inWsA2,
      takeoverRequestedBy: ids.userA2,
    }),
    withFormerRequest: await seedSession({
      ...inWsA2,
      takeoverRequestedBy: formerRequester,
    }),
    expired: await seedSession({
      ...inWsA2,
      tokenExpiresAt: new Date(Date.now() - 60 * 1000),
    }),
    closed: await seedSession({ ...inWsA2, status: "finalized" }),
    revoked: await seedSession({
      createdBy: revokedCreator,
      entityId: ids.entityA1,
      entityVersionId: ids.entityVersionA1,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
    }),
    // userA1 also belongs to orgB and its matter wsB1.
    foreign: await seedSession({
      createdBy: ids.userA1,
      entityId: ids.entityB1,
      entityVersionId: ids.entityVersionB1,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
    }),
  };

  // The requester leaves after asking; the creator loses the matter.
  await testDb.delete(member).where(eq(member.id, formerMembershipId));
  await testDb
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ids.wsA1),
        eq(workspaceMembers.userId, revokedCreator),
      ),
    );
});

afterAll(async () => {
  for (const session of Object.values(sessions)) {
    await testDb
      .delete(desktopEditSessions)
      .where(eq(desktopEditSessions.id, session.id));
  }
  for (const userId of createdUsers) {
    await testDb.delete(user).where(eq(user.id, userId));
  }
  await releaseTestDb();
});

describe("desktop edit session event state", () => {
  test("names a requester who is a member of the organization", async () => {
    const session = sessions.withMemberRequest;
    const state = await sessionScope(
      session,
      async (tx) => await readDesktopEditSessionEventState(tx, session.id),
    );

    expect(state?.pendingRequest?.requestedByName).toBe("User A2");
    expect(state?.pendingRequest?.requestedAt).toBeInstanceOf(Date);
  });

  test("keeps the request but not the name of a requester who has left", async () => {
    const session = sessions.withFormerRequest;
    const state = await sessionScope(
      session,
      async (tx) => await readDesktopEditSessionEventState(tx, session.id),
    );

    expect(state?.pendingRequest?.requestedByName).toBeNull();
    expect(state?.pendingRequest?.requestedAt).toBeInstanceOf(Date);
  });

  test("reports nothing once the creator loses the matter, although the scope still pins it", async () => {
    const session = sessions.revoked;
    const state = await sessionScope(
      session,
      async (tx) => await readDesktopEditSessionEventState(tx, session.id),
    );

    expect(state).toBeNull();
  });

  test("cannot reach a session outside the scope's organization", async () => {
    const foreign = sessions.foreign;
    const state = await sessionScope(
      sessions.withMemberRequest,
      async (tx) => await readDesktopEditSessionEventState(tx, foreign.id),
    );

    expect(state).toBeNull();
  });
});

describe("desktop edit session liveness", () => {
  test("extends a live session for its creator and token", async () => {
    const session = sessions.withMemberRequest;
    const before = await readTokenExpiry(session.id);

    const refreshed = await sessionScope(
      session,
      async (tx) =>
        await refreshDesktopEditSessionLiveness(tx, {
          sessionId: session.id,
          sessionToken: session.token,
          userId: session.createdBy,
        }),
    );

    expect(refreshed).toBe(true);
    expect((await readTokenExpiry(session.id))?.getTime()).toBeGreaterThan(
      before?.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });

  test("refuses a wrong token", async () => {
    const session = sessions.withFormerRequest;

    const refreshed = await sessionScope(
      session,
      async (tx) =>
        await refreshDesktopEditSessionLiveness(tx, {
          sessionId: session.id,
          sessionToken: sessions.withMemberRequest.token,
          userId: session.createdBy,
        }),
    );

    expect(refreshed).toBe(false);
  });

  test("refuses an expired token", async () => {
    const session = sessions.expired;

    const refreshed = await sessionScope(
      session,
      async (tx) =>
        await refreshDesktopEditSessionLiveness(tx, {
          sessionId: session.id,
          sessionToken: session.token,
          userId: session.createdBy,
        }),
    );

    expect(refreshed).toBe(false);
  });

  test("refuses a closed session", async () => {
    const session = sessions.closed;

    const refreshed = await sessionScope(
      session,
      async (tx) =>
        await refreshDesktopEditSessionLiveness(tx, {
          sessionId: session.id,
          sessionToken: session.token,
          userId: session.createdBy,
        }),
    );

    expect(refreshed).toBe(false);
  });

  test("cannot extend a session outside the scope's organization, even with its token", async () => {
    const foreign = sessions.foreign;
    const before = await readTokenExpiry(foreign.id);

    const refreshed = await sessionScope(
      sessions.withMemberRequest,
      async (tx) =>
        await refreshDesktopEditSessionLiveness(tx, {
          sessionId: foreign.id,
          sessionToken: foreign.token,
          userId: foreign.createdBy,
        }),
    );

    expect(refreshed).toBe(false);
    expect(await readTokenExpiry(foreign.id)).toEqual(before);
  });
});
