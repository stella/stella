import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import {
  MATTER_VISIBILITY,
  newNotificationRealtimeEvent,
  RESOURCE_TYPE,
  resourceRef,
  resourceUpdatedRealtimeEvent,
} from "@stll/api-contract";
import { SSE_HEARTBEAT_FRAME } from "@stll/api-contract/sse-heartbeat";

import { rlsDb } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createMembershipSafeDb } from "@/api/db/scoped";
import { notificationsRoute } from "@/api/handlers/notifications/routes";
import { workspaceEventsRoute } from "@/api/handlers/workspaces/events";
import { removeWorkspaceMemberHandler } from "@/api/handlers/workspaces/members/remove";
import { workspacesRoute } from "@/api/handlers/workspaces/routes";
import { createHttpApp } from "@/api/http/app";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { getAuth, realtimeAuthorizers } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import {
  brandActorSessionIdentity,
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { broadcast, broadcastToUser, startSse, stopSse } from "@/api/lib/sse";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A matter's event stream across the removal of one of its members: the real
// stream route and its workspace access served over HTTP, the real
// member-removal route, and the real revocation it triggers.

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
  // The same connection authorizers the server starts with, so an event
  // broadcast during the test re-checks access the way production does.
  startSse(realtimeAuthorizers);
});

const server = serveForTest(
  createHttpApp({
    routes: [
      ...workspaceEventsRoute,
      ...notificationsRoute,
      ...workspacesRoute,
    ],
    middleware: [errorBoundary],
  }),
);

afterAll(async () => {
  await server.stop();
  stopSse();
  await releaseAgentAuthTestDb();
});

const BASE = "http://localhost";
// Longer than one in-process revocation needs, shorter than the heartbeat, so
// a timeout here means the stream was left open rather than just slow.
const STREAM_CLOSE_WAIT_MS = 2000;

const openEventStream = async (browser: HumanBrowser, workspaceId: string) =>
  await server.fetch(
    new Request(`${BASE}/workspaces/${workspaceId}/events`, {
      headers: { cookie: browser.cookieHeader() },
    }),
  );

const openUserEventStream = async (browser: HumanBrowser) =>
  await server.fetch(
    new Request(`${BASE}/v1/notifications/events`, {
      headers: { cookie: browser.cookieHeader() },
    }),
  );

const heartbeatDecoder = new TextDecoder();

/** A chunk of nothing but heartbeat frames, which carry no event. */
const isHeartbeatOnly = (chunk: Uint8Array) =>
  heartbeatDecoder
    .decode(chunk)
    .split(SSE_HEARTBEAT_FRAME)
    .every((part) => part === "");

const readNextChunk = async (response: Response) => {
  const { body } = response;
  if (!body) {
    throw new Error("The event stream has no body");
  }
  const reader = body.getReader();
  try {
    const deadline = Bun.sleep(STREAM_CLOSE_WAIT_MS).then(
      () => "timeout" as const,
    );
    // A heartbeat keeps an idle connection open and says nothing about
    // delivery; a slow setup can queue one before the step under test.
    for (;;) {
      const result = await Promise.race([reader.read(), deadline]);
      if (
        result === "timeout" ||
        result.done ||
        !isHeartbeatOnly(result.value)
      ) {
        return result;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
};

type StreamOutcome = "closed" | "open";

/** Drain the stream until it ends, or report it still open after the wait. */
const awaitStreamEnd = async (response: Response): Promise<StreamOutcome> => {
  const { body } = response;
  if (!body) {
    throw new Error("The event stream has no body");
  }
  const reader = body.getReader();
  try {
    const deadline = Bun.sleep(STREAM_CLOSE_WAIT_MS).then(
      () => "open" as const,
    );
    const drain = async (): Promise<StreamOutcome> => {
      for (;;) {
        const { done } = await reader.read();
        if (done) {
          return "closed";
        }
      }
    };
    const outcome = await Promise.race([drain(), deadline]);
    if (outcome === "open") {
      await reader.cancel();
    }
    return outcome;
  } finally {
    reader.releaseLock();
  }
};

type MatterFixture = {
  owner: HumanBrowser;
  member: HumanBrowser;
  organizationId: string;
  workspaceId: SafeId<"workspace">;
};

/** An organization owner and a plain member, both assigned to one matter. */
const createMatterWithMember = async (): Promise<MatterFixture> => {
  const auth = getAuth();
  const owner = await signInHuman(
    `matter-owner-${Bun.randomUUIDv7()}@stella.dev`,
  );
  const organization = await auth.api.createOrganization({
    body: {
      name: "Matter events",
      slug: `matter-events-${Bun.randomUUIDv7()}`,
    },
    headers: owner.headers(),
  });
  await owner.setActiveOrganization(organization.id);

  const member = await signInHuman(
    `matter-member-${Bun.randomUUIDv7()}@stella.dev`,
  );
  const invitation = await auth.api.createInvitation({
    body: {
      email: member.email,
      role: "member",
      organizationId: organization.id,
    },
    headers: owner.headers(),
  });
  await auth.api.acceptInvitation({
    body: { invitationId: invitation.id },
    headers: member.headers(),
  });
  await member.setActiveOrganization(organization.id);

  const workspaceId = createSafeId<"workspace">();
  await testDb.insert(workspaces).values({
    visibility: MATTER_VISIBILITY.adminsAndAssigned,
    id: workspaceId,
    organizationId: brandPersistedOrganizationId(organization.id),
    name: "Matter events",
    reference: `ME-${workspaceId.slice(-6)}`,
    status: "active",
  });
  await testDb.insert(workspaceMembers).values([
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId: owner.userId,
    },
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId: member.userId,
    },
  ]);
  return { owner, member, organizationId: organization.id, workspaceId };
};

describe("a matter's event stream when a member is removed", () => {
  test("closes the removed member's open stream and refuses their reconnect as not found", async () => {
    const { owner, member, workspaceId } = await createMatterWithMember();

    const memberStream = await openEventStream(member, workspaceId);
    expect(memberStream.status).toBe(200);
    const ownerStream = await openEventStream(owner, workspaceId);
    expect(ownerStream.status).toBe(200);

    const removal = await server.fetch(
      new Request(
        `${BASE}/workspaces/${workspaceId}/members/${member.userId}`,
        {
          method: "DELETE",
          headers: { cookie: owner.cookieHeader() },
        },
      ),
    );
    expect(removal.status, await removal.clone().text()).toBe(200);

    expect(await awaitStreamEnd(memberStream)).toBe("closed");
    // Revocation is per member: the rest of the matter keeps its stream.
    expect(await awaitStreamEnd(ownerStream)).toBe("open");

    // 404, the same answer as for a matter that never existed, is what the
    // client reads as "access to this matter has ended" rather than an outage.
    const reconnect = await openEventStream(member, workspaceId);
    expect(reconnect.status).toBe(404);
    await reconnect.body?.cancel();
  });

  test("closes the removed member's open stream when the removal comes through the agent tool path", async () => {
    // The agent tool calls the shared removal directly, without the HTTP
    // route's resource-set broadcast, so the stream can only close through
    // the removal's own revocation.
    const { owner, member, organizationId, workspaceId } =
      await createMatterWithMember();
    const memberStream = await openEventStream(member, workspaceId);
    expect(memberStream.status).toBe(200);

    const identity = brandActorSessionIdentity({
      organizationId,
      userId: owner.userId,
    });
    const removal = await Result.gen(() =>
      removeWorkspaceMemberHandler({
        organizationId: identity.organizationId,
        safeDb: createMembershipSafeDb(rlsDb, {
          ...identity,
          serverValidatedWorkspaceIds: [workspaceId],
        }),
        workspaceId,
        userId: brandPersistedUserId(member.userId),
        actorUserId: identity.userId,
        managesOrganizationMatters: false,
        recordAuditEvent: createAuditRecorder({
          ...identity,
          workspaceId,
          request: new Request(`${BASE}/mcp`),
          server: null,
        }),
      }),
    );
    expect(removal.isOk()).toBe(true);

    expect(await awaitStreamEnd(memberStream)).toBe("closed");
  });
});

describe("event streams when their opening session ends", () => {
  test("stops workspace and user delivery only for the revoked session", async () => {
    const { member, organizationId, workspaceId } =
      await createMatterWithMember();
    const otherSession = await signInHuman(member.email);
    await otherSession.setActiveOrganization(organizationId);

    const revokedSession = await getAuth().api.getSession({
      headers: member.headers(),
    });
    const liveSession = await getAuth().api.getSession({
      headers: otherSession.headers(),
    });
    if (!revokedSession || !liveSession) {
      throw new Error("Expected both signed-in sessions");
    }

    const revokedWorkspaceStream = await openEventStream(member, workspaceId);
    const liveWorkspaceStream = await openEventStream(
      otherSession,
      workspaceId,
    );
    const revokedUserStream = await openUserEventStream(member);
    const liveUserStream = await openUserEventStream(otherSession);
    expect(revokedWorkspaceStream.status).toBe(200);
    expect(liveWorkspaceStream.status).toBe(200);
    expect(revokedUserStream.status).toBe(200);
    expect(liveUserStream.status).toBe(200);

    const revocation = await getAuth().api.revokeSession({
      body: { token: revokedSession.session.token },
      headers: otherSession.headers(),
    });
    expect(revocation.status).toBe(true);

    broadcast(
      workspaceId,
      resourceUpdatedRealtimeEvent(
        resourceRef({
          type: RESOURCE_TYPE.ENTITY,
          id: createSafeId<"entity">(),
        }),
      ),
    );
    broadcastToUser(
      brandPersistedUserId(member.userId),
      brandPersistedOrganizationId(organizationId),
      newNotificationRealtimeEvent(),
    );

    expect(await readNextChunk(revokedWorkspaceStream)).toEqual({
      done: true,
      value: undefined,
    });
    expect(await readNextChunk(revokedUserStream)).toEqual({
      done: true,
      value: undefined,
    });
    expect(await readNextChunk(liveWorkspaceStream)).toMatchObject({
      done: false,
    });
    expect(await readNextChunk(liveUserStream)).toMatchObject({ done: false });
  });
});
