import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import {
  CHAT_ACTIVE_RUN_STATE,
  CHAT_TURN_INTERACTION_TYPES,
} from "@stll/api-contract/chat";
import type { ChatActiveRun } from "@stll/api-contract/chat";

import type { ScopedDb } from "@/api/db/safe-db";
import { workspaces } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import { WithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-projection";
import type { ChatTurnStatus } from "@/api/lib/chat/turn-status";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  ACTIVE_RUNS_PAGE,
  chatActiveRunsScalingScenario,
  seedChatActiveRunsScaling,
  seedChatTurns,
} from "@/api/tests/read-scaling/chat-active-runs";
import type { SeededChatTurn } from "@/api/tests/read-scaling/chat-active-runs";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createListActiveChatRuns } from "./list";

// The sidebar's read of the member's unfinished chat runs: only their own,
// only in the active organization, only unfinished, in a stable order.

type ListCtx = Parameters<
  ReturnType<typeof createListActiveChatRuns>["handler"]
>[0];

let testDb: TestDatabase;
let ids: TestIds;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

const cleanUp = async () => {
  for (const cleanup of cleanups.splice(0)) {
    // db-await-in-loop: one delete per seeded batch, a handful per test
    await cleanup();
  }
};

afterEach(cleanUp);

afterAll(async () => {
  await cleanUp();
  await releaseRlsFixture();
});

const listActiveChatRuns = createListActiveChatRuns({
  readCopies: async () => new WithdrawnCopyProjection([], "Withdrawn"),
});

const BASE_MS = Date.parse("2026-10-02T08:00:00.000Z");
const at = (seconds: number) => new Date(BASE_MS + seconds * 1000);

const seed = async (turns: readonly SeededChatTurn[]) => {
  const seeded = await seedChatTurns(testDb, turns);
  cleanups.push(seeded.cleanup);
  return seeded.threadIds;
};

const mine = (
  status: ChatTurnStatus,
  overrides: Partial<SeededChatTurn> = {},
): SeededChatTurn => ({
  createdAt: at(0),
  organizationId: ids.orgA,
  status,
  title: `My ${status} run`,
  userId: ids.userA1,
  workspaceId: ids.wsA1,
  ...overrides,
});

const requestPage = async ({
  cursor,
  limit,
  organizationId = ids.orgA,
  userId = ids.userA1,
  workspaceIds = [ids.wsA1, ids.wsA2],
}: {
  cursor?: string | undefined;
  limit?: number | undefined;
  organizationId?: SafeId<"organization">;
  userId?: SafeId<"user">;
  workspaceIds?: SafeId<"workspace">[];
}) =>
  await listActiveChatRuns.handler(
    asTestRaw<ListCtx>({
      memberRole: sessionMemberRole("member"),
      query: {
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      },
      request: new Request("http://localhost/v1/chat/runs/active"),
      route: "/v1/chat/runs/active" satisfies ApiRoutePath,
      safeDb: toSafeDbMock(
        asTestRaw<ScopedDb>(
          createScopedDb(testDb, workspaceIds, organizationId, userId),
        ),
      ),
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
    }),
  );

const listPage = async (options: Parameters<typeof requestPage>[0] = {}) => {
  const response = await requestPage(options);
  if (response instanceof HttpStatusResponse || !("items" in response)) {
    return panic(`Active runs read failed: ${JSON.stringify(response)}`);
  }
  return response;
};

/** Every run the member's pages hold, following each cursor to the end. */
const listAll = async (
  options: Parameters<typeof requestPage>[0] = {},
): Promise<ChatActiveRun[]> => {
  const items: ChatActiveRun[] = [];
  let cursor: string | undefined;
  for (;;) {
    // db-await-in-loop: a cursor walk reads one page per request by design
    const page = await listPage({ ...options, cursor });
    items.push(...page.items);
    if (page.nextCursor === null) {
      return items;
    }
    cursor = page.nextCursor;
  }
};

describe("the member's active chat runs", () => {
  test("lists only the member's own unfinished runs in the active organization", async () => {
    const seeded = await seed([
      mine("accepted"),
      mine("running"),
      mine("awaiting-user"),
      mine("completed"),
      mine("failed"),
      mine("cancelled"),
      mine("interrupted"),
      // A colleague's runs in the same organization and matter.
      mine("running", { title: "Colleague run", userId: ids.userA2 }),
      mine("awaiting-user", { title: "Colleague wait", userId: ids.userA2 }),
      // The member's own run in another organization they belong to.
      mine("running", {
        organizationId: ids.orgB,
        title: "Other firm run",
        workspaceId: ids.wsB1,
      }),
    ]);
    const seededIds = new Set<string>(seeded);
    // Seeded in order: the first three are the member's unfinished runs.
    const unfinished: string[] = seeded.slice(0, 3);

    const listed = await listAll();
    // The fixture is shared, so only the seeded threads are compared.
    const seededOnly = listed.filter((run) => seededIds.has(run.threadId));

    expect(seededOnly.map((run) => run.threadId).toSorted()).toEqual(
      unfinished.toSorted(),
    );
    expect(seededOnly.map((run) => run.threadTitle).toSorted()).toEqual([
      "My accepted run",
      "My awaiting-user run",
      "My running run",
    ]);
    for (const run of seededOnly) {
      expect(run.workspaceId).toBe(ids.wsA1);
    }
  });

  test("maps each unfinished status to its state and the moment it entered it", async () => {
    const [accepted, running, continued, awaiting] = await seed([
      mine("accepted", { createdAt: at(10), activeStartedAt: at(11) }),
      // A turn with no active span counts from its acceptance.
      mine("running", { createdAt: at(20), activeStartedAt: null }),
      // A continuation counts from the start of its current span.
      mine("running", { createdAt: at(30), activeStartedAt: at(45) }),
      mine("awaiting-user", {
        activeStartedAt: null,
        createdAt: at(40),
        updatedAt: at(50),
      }),
    ]);

    const byThread = new Map(
      (await listAll()).map((run) => [run.threadId, run]),
    );

    expect(byThread.get(accepted ?? "")).toMatchObject({
      since: at(11).toISOString(),
      state: CHAT_ACTIVE_RUN_STATE.working,
    });
    expect(byThread.get(running ?? "")).toMatchObject({
      since: at(20).toISOString(),
      state: CHAT_ACTIVE_RUN_STATE.working,
    });
    expect(byThread.get(continued ?? "")).toMatchObject({
      since: at(45).toISOString(),
      state: CHAT_ACTIVE_RUN_STATE.working,
    });
    expect(byThread.get(awaiting ?? "")).toMatchObject({
      since: at(50).toISOString(),
      state: CHAT_ACTIVE_RUN_STATE.needsYou,
    });
    // Only a waiting run says what it waits on.
    expect(byThread.get(running ?? "")).not.toHaveProperty("interaction");
  });

  test("a waiting run names what it waits on, for every interaction a turn stores", async () => {
    const threadIds = await seed(
      CHAT_TURN_INTERACTION_TYPES.map((interactionType) =>
        mine("awaiting-user", { interactionType, title: interactionType }),
      ),
    );

    const byThread = new Map(
      (await listAll()).map((run) => [run.threadId, run]),
    );

    expect(
      threadIds.map((threadId) => {
        const run = byThread.get(threadId);
        return run?.state === CHAT_ACTIVE_RUN_STATE.needsYou
          ? run.interaction
          : undefined;
      }),
    ).toEqual([...CHAT_TURN_INTERACTION_TYPES]);
  });

  test("orders runs waiting on the member first, then oldest first", async () => {
    await seed([
      mine("running", { createdAt: at(1) }),
      mine("awaiting-user", { createdAt: at(2), updatedAt: at(9) }),
      mine("accepted", { createdAt: at(0) }),
      mine("awaiting-user", { createdAt: at(3), updatedAt: at(4) }),
    ]);

    const listed = await listAll();

    const states = listed.map((run) => run.state);
    const firstWorking = states.indexOf(CHAT_ACTIVE_RUN_STATE.working);
    expect(firstWorking).toBeGreaterThan(0);
    expect(
      states
        .slice(firstWorking)
        .every((state) => state === CHAT_ACTIVE_RUN_STATE.working),
    ).toBe(true);
    for (const group of [
      listed.slice(0, firstWorking),
      listed.slice(firstWorking),
    ]) {
      const sinces = group.map((run) => run.since);
      expect(sinces).toEqual(sinces.toSorted());
    }
  });

  test("pages through every run exactly once, and a cursor survives a run starting between pages", async () => {
    const seededThreads = await seed(
      Array.from({ length: 7 }, (_, index) =>
        mine(index % 3 === 0 ? "awaiting-user" : "running", {
          createdAt: at(100 + index),
          // Two runs share one instant, so the thread id breaks the tie.
          updatedAt: at(index < 2 ? 200 : 200 + index),
        }),
      ),
    );
    const everything = await listAll();

    const first = await listPage({ limit: 3 });
    expect(first.items).toEqual(everything.slice(0, 3));
    expect(first.limit).toBe(3);
    const cursor = first.nextCursor ?? panic("Expected a second page");

    // A run that sorts before the cursor starts after the first page was read.
    const [late] = await seed([
      mine("awaiting-user", { createdAt: at(0), updatedAt: at(1) }),
    ]);

    const rest: ChatActiveRun[] = [];
    let next: string | null = cursor;
    while (next !== null) {
      // db-await-in-loop: a cursor walk reads one page per request by design
      const page = await listPage({ cursor: next, limit: 3 });
      rest.push(...page.items);
      next = page.nextCursor;
    }

    expect([...first.items, ...rest]).toEqual(everything);
    expect(rest.map((run) => run.threadId)).not.toContain(late);
    for (const threadId of seededThreads) {
      expect(everything.map((run) => run.threadId)).toContain(threadId);
    }
  });

  test("refuses a cursor it did not issue instead of restarting", async () => {
    // `["needs-you"]`: issuable text, but not a position in this list.
    expect(await requestPage({ cursor: "WyJuZWVkcy15b3UiXQ" })).toEqual({
      code: 400,
      response: {
        code: "invalid_cursor",
        message: "Invalid cursor",
        hint: "Restart the list without a cursor.",
      },
    });
  });

  test("leaves out a run in a matter that is being deleted", async () => {
    const [deleting] = await seed([mine("running", { workspaceId: ids.wsA2 })]);
    await testDb
      .update(workspaces)
      .set({ status: "deleting" })
      .where(eq(workspaces.id, ids.wsA2));
    try {
      const listed = await listAll();
      expect(listed.map((run) => run.threadId)).not.toContain(deleting);
    } finally {
      await testDb
        .update(workspaces)
        .set({ status: "active" })
        .where(eq(workspaces.id, ids.wsA2));
    }
  });

  test("reads the same work for ten unfinished runs whatever the member's history and colleagues hold", async () => {
    const seedAt = async (size: number) =>
      await seedChatActiveRunsScaling(testDb, {
        // The scaling page is this organization's only content.
        organizationId: ids.orgB,
        otherUserId: ids.userB1,
        userId: ids.userA1,
        workspaceId: ids.wsB1,
        size,
      });
    const small = await seedAt(10);
    try {
      const at10 = await chatActiveRunsScalingScenario.measure(small);
      await small.cleanup();
      const large = await seedAt(200);
      try {
        const at200 = await chatActiveRunsScalingScenario.measure(large);
        console.info(
          "handler-scaling",
          JSON.stringify({ name: "chat active runs", at10, at200 }),
        );
        expect(at10.rows).toBe(ACTIVE_RUNS_PAGE);
        expect(at200.rows).toBe(ACTIVE_RUNS_PAGE);
        expect(at10.statements).toBeGreaterThan(0);
        expect(readScalingViolations({ small: at10, large: at200 })).toEqual(
          [],
        );
      } finally {
        await large.cleanup();
      }
    } finally {
      await small.cleanup();
    }
  });
});
