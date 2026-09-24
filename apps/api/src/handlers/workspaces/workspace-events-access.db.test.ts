import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import { rlsDb } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createMembershipSafeDb } from "@/api/db/scoped";
import { workspaceEventsRoute } from "@/api/handlers/workspaces/events";
import { removeWorkspaceMemberHandler } from "@/api/handlers/workspaces/members/remove";
import { workspacesRoute } from "@/api/handlers/workspaces/routes";
import { createAuditRecorder } from "@/api/lib/audit-log";
import {
  getAuth,
  resolveUserRealtimeAuthorization,
  resolveWorkspaceRealtimeAudience,
} from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  brandActorSessionIdentity,
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { startSse, stopSse } from "@/api/lib/sse";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A matter's event stream across the removal of one of its members: the real
// stream route and its access macro, the real member-removal route, and the
// real revocation it triggers.

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
  // The same connection authorizers the server starts with, so an event
  // broadcast during the test re-checks access the way production does.
  startSse({
    user: resolveUserRealtimeAuthorization,
    workspace: resolveWorkspaceRealtimeAudience,
  });
});

afterAll(async () => {
  stopSse();
  await releaseAgentAuthTestDb();
});

const BASE = "http://localhost";
// Longer than one in-process revocation needs, shorter than the heartbeat, so
// a timeout here means the stream was left open rather than just slow.
const STREAM_CLOSE_WAIT_MS = 2000;

const openEventStream = async (browser: HumanBrowser, workspaceId: string) =>
  await workspaceEventsRoute.handle(
    new Request(`${BASE}/workspaces/${workspaceId}/events`, {
      headers: { cookie: browser.cookieHeader() },
    }),
  );

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

    const removal = await workspacesRoute.handle(
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
        safeDb: createMembershipSafeDb(rlsDb, {
          ...identity,
          serverValidatedWorkspaceIds: [workspaceId],
        }),
        workspaceId,
        userId: brandPersistedUserId(member.userId),
        actorUserId: identity.userId,
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
