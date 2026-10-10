import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import {
  isResourceType,
  REALTIME_EVENT_TYPE,
  RESOURCE_TYPE,
  type ResourceType,
} from "@stll/api-contract";

import { workspaceMembers, workspaces } from "@/api/db/schema";
import { workspaceEventsRoute } from "@/api/handlers/workspaces/events";
import { workspacesRoute } from "@/api/handlers/workspaces/routes";
import { getAuth, realtimeAuthorizers } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { broadcastWorkspaceResourceSetUpdated } from "@/api/lib/resource-realtime";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import { startSse, stopSse } from "@/api/lib/sse";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// An open matter tab refreshes its lists from `resource_set_updated` events on
// the matter's event stream. A write must announce itself there whichever
// transport ran it: the REST route the web app calls, and `write_capability`,
// which MCP clients and the CLI use. Both drive the real handler, the real
// database and the real event stream here.

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
  startSse(realtimeAuthorizers);
});

afterAll(async () => {
  stopSse();
  await releaseAgentAuthTestDb();
});

const BASE = "http://localhost";

type MatterFixture = {
  owner: HumanBrowser;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  /** A second matter of the same organization, holding `takenReference`. */
  takenReference: string;
};

const createMatter = async (): Promise<MatterFixture> => {
  const auth = getAuth();
  const owner = await signInHuman(
    `realtime-owner-${Bun.randomUUIDv7()}@stella.dev`,
  );
  const organization = await auth.api.createOrganization({
    body: {
      name: "Realtime matters",
      slug: `realtime-matters-${Bun.randomUUIDv7()}`,
    },
    headers: owner.headers(),
  });
  await owner.setActiveOrganization(organization.id);
  const organizationId = brandPersistedOrganizationId(organization.id);

  const workspaceId = createSafeId<"workspace">();
  const otherWorkspaceId = createSafeId<"workspace">();
  const takenReference = `TAKEN-${otherWorkspaceId.slice(-6)}`;
  await testDb.insert(workspaces).values([
    {
      id: workspaceId,
      organizationId,
      name: "Open in a tab",
      reference: `RT-${workspaceId.slice(-6)}`,
      status: "active",
    },
    {
      id: otherWorkspaceId,
      organizationId,
      name: "Holds a reference",
      reference: takenReference,
      status: "active",
    },
  ]);
  await testDb.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId: owner.userId,
  });
  return { owner, organizationId, workspaceId, takenReference };
};

type ResourceSetEvent = { resourceType: ResourceType };

/**
 * Reads `resource_set_updated` events off a matter's event stream. Delivery to
 * one matter is ordered, so `untilMarker` collects exactly the events published
 * before a marker the test broadcasts itself: a write that announced nothing
 * shows up as an empty list without waiting on a clock.
 */
const openResourceSetEvents = async (
  browser: HumanBrowser,
  workspaceId: SafeId<"workspace">,
) => {
  const response = await workspaceEventsRoute.handle(
    new Request(`${BASE}/workspaces/${workspaceId}/events`, {
      headers: { cookie: browser.cookieHeader() },
    }),
  );
  expect(response.status).toBe(200);
  const body = response.body;
  if (!body) {
    throw new Error("The event stream has no body");
  }
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  const pending: ResourceSetEvent[] = [];

  const nextEvent = async (): Promise<ResourceSetEvent> => {
    for (;;) {
      const queued = pending.shift();
      if (queued) {
        return queued;
      }
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("The event stream closed");
      }
      buffered += value;
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (data === undefined) {
          continue;
        }
        const event: unknown = JSON.parse(data);
        if (
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED &&
          "resourceType" in event &&
          isResourceType(event.resourceType)
        ) {
          pending.push({ resourceType: event.resourceType });
        }
      }
    }
  };

  // Nothing in these tests announces this type, so it marks a position in the
  // stream.
  const MARKER = RESOURCE_TYPE.EXPENSE;
  const untilMarker = async (): Promise<ResourceType[]> => {
    broadcastWorkspaceResourceSetUpdated(workspaceId, MARKER);
    const seen: ResourceType[] = [];
    for (;;) {
      const event = await nextEvent();
      if (event.resourceType === MARKER) {
        return seen;
      }
      seen.push(event.resourceType);
    }
  };

  return {
    untilMarker,
    close: async () => {
      await reader.cancel();
    },
  };
};

const restUpdateMatter = async (
  fixture: MatterFixture,
  body: Record<string, unknown>,
) =>
  await workspacesRoute.handle(
    new Request(`${BASE}/workspaces/${fixture.workspaceId}`, {
      method: "POST",
      headers: {
        cookie: fixture.owner.cookieHeader(),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

const mcpUpdateMatter = async (
  fixture: MatterFixture,
  body: Record<string, unknown>,
) => {
  const request = new Request(`${BASE}/mcp`, { method: "POST" });
  const context = await resolveMcpSessionContext(
    {
      organizationId: fixture.organizationId,
      scopes: ["stella:read", "stella:matters_write"],
      userId: fixture.owner.userId,
    },
    { request },
  );
  return await handleMcpToolCall({
    mode: "advanced",
    args: {
      capability: "matters.update",
      input: { params: { matterId: fixture.workspaceId }, body },
    },
    context: {
      ...context,
      testDependencies: {
        // The per-capability limiter is not under test here.
        consumeInvokeCapabilityRateLimit: async () =>
          await Promise.resolve({ ok: true, retryAfterSeconds: 0 }),
      },
    },
    toolName: "write_capability",
  });
};

const readMatter = async (workspaceId: SafeId<"workspace">) =>
  await testDb
    .select({
      name: workspaces.name,
      reference: workspaces.reference,
      clientId: workspaces.clientId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .then((rows) => rows.at(0));

describe("a matter write announces its resource set on the matter's event stream", () => {
  test("through the REST route: once on success, never on a refusal or a rolled-back write", async () => {
    const fixture = await createMatter();
    const events = await openResourceSetEvents(
      fixture.owner,
      fixture.workspaceId,
    );
    try {
      const renamed = await restUpdateMatter(fixture, {
        name: "Renamed in the web app",
      });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
      expect(await events.untilMarker()).toEqual([RESOURCE_TYPE.WORKSPACE]);

      // Refused inside the handler: a bare client on a personal matter.
      const refused = await restUpdateMatter(fixture, {
        clientId: createSafeId<"contact">(),
      });
      expect(refused.status).toBe(400);
      // Rolled back: the reference belongs to another matter, so the UPDATE
      // fails on the unique index and the transaction aborts.
      const rolledBack = await restUpdateMatter(fixture, {
        name: "Never written",
        reference: fixture.takenReference,
      });
      expect(rolledBack.status).toBe(409);
      expect(await events.untilMarker()).toEqual([]);
      expect(await readMatter(fixture.workspaceId)).toMatchObject({
        name: "Renamed in the web app",
        clientId: null,
      });
    } finally {
      await events.close();
    }
  });

  test("through write_capability (MCP and CLI): once on success, never on a refusal or a rolled-back write", async () => {
    const fixture = await createMatter();
    const events = await openResourceSetEvents(
      fixture.owner,
      fixture.workspaceId,
    );
    try {
      const renamed = await mcpUpdateMatter(fixture, {
        name: "Renamed by an agent",
      });
      expect(renamed.isError, JSON.stringify(renamed)).not.toBe(true);
      expect(await readMatter(fixture.workspaceId)).toMatchObject({
        name: "Renamed by an agent",
      });
      expect(await events.untilMarker()).toEqual([RESOURCE_TYPE.WORKSPACE]);

      const refused = await mcpUpdateMatter(fixture, {
        clientId: createSafeId<"contact">(),
      });
      expect(refused.isError).toBe(true);
      const rolledBack = await mcpUpdateMatter(fixture, {
        name: "Never written",
        reference: fixture.takenReference,
      });
      expect(rolledBack.isError).toBe(true);
      expect(await events.untilMarker()).toEqual([]);
      expect(await readMatter(fixture.workspaceId)).toMatchObject({
        name: "Renamed by an agent",
        clientId: null,
      });
    } finally {
      await events.close();
    }
  });
});
