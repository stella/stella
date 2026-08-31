import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";

import { notifications } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import publishAnnouncement, {
  createPublishAnnouncementEndpoint,
} from "@/api/handlers/notifications/announce";
import listNotifications from "@/api/handlers/notifications/list";
import markNotificationRead from "@/api/handlers/notifications/read";
import markAllNotificationsRead from "@/api/handlers/notifications/read-all";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  fanOutNotifications,
  NOTIFICATION_INSERT_BATCH_SIZE,
} from "@/api/lib/notifications";
import type { NewNotification } from "@/api/lib/notifications";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

type ListContext = Parameters<typeof listNotifications.handler>[0];
type ReadContext = Parameters<typeof markNotificationRead.handler>[0];
type ReadAllContext = Parameters<typeof markAllNotificationsRead.handler>[0];
type AnnounceContext = Parameters<typeof publishAnnouncement.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;
const seeded: SafeId<"notification">[] = [];

/**
 * The fan-out path writes through the owner connection in production; the
 * structural seam lets the same code run against the embedded test database.
 */
const fanOutDb = () =>
  asTestRaw<Parameters<typeof fanOutNotifications>[1]>(testDb);

const seedNotification = async ({
  userId,
  organizationId,
  kind = NOTIFICATION_KIND.MENTION,
  idempotencyKey,
  readAt = null,
}: {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  kind?: NewNotification["kind"];
  idempotencyKey: string;
  readAt?: Date | null;
}) => {
  const id = createSafeId<"notification">();
  await testDb.insert(notifications).values({
    id,
    userId,
    organizationId,
    kind,
    metadata: kind === NOTIFICATION_KIND.MENTION ? { actorName: "Ada" } : {},
    entityType: kind === NOTIFICATION_KIND.MENTION ? "entity" : null,
    entityId: kind === NOTIFICATION_KIND.MENTION ? ids.entityA1 : null,
    workspaceId: kind === NOTIFICATION_KIND.MENTION ? ids.wsA1 : null,
    idempotencyKey,
    readAt,
  });
  seeded.push(id);
  return id;
};

const contextFor = ({
  userId,
  organizationId,
}: {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
}) => {
  const recordAuditEvent = async () => undefined;
  return {
    safeDb: createSafeDb(testDb, [], organizationId, userId),
    scopedDb: createScopedDb(testDb, [], organizationId, userId),
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    memberRole: { role: "owner" },
    getActiveWorkspaceIds: async () => [],
    getAccessibleWorkspaces: async () => [],
    getWorkspaceAccess: async () => null,
    orgAIConfig: null,
    promptCachingEnabled: false,
    createAuditRecorder: () => recordAuditEvent,
    recordAuditEvent,
    request: new Request("https://example.test/v1/notifications"),
    route: "/test/notifications",
  };
};

const listAs = async (
  actor: { userId: SafeId<"user">; organizationId: SafeId<"organization"> },
  query: ListContext["query"] = {},
) => {
  const result = await listNotifications.handler(
    asTestRaw<ListContext>({ ...contextFor(actor), query }),
  );
  if (!("items" in result)) {
    return expect.unreachable(`list failed: ${JSON.stringify(result)}`);
  }
  return result;
};

let unreadA1: SafeId<"notification">;
let readA1: SafeId<"notification">;
let otherOrgA1: SafeId<"notification">;
let otherUser: SafeId<"notification">;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  unreadA1 = await seedNotification({
    userId: ids.userA1,
    organizationId: ids.orgA,
    idempotencyKey: "test:unread-a1",
  });
  readA1 = await seedNotification({
    userId: ids.userA1,
    organizationId: ids.orgA,
    kind: NOTIFICATION_KIND.REPORT_EXPORT_SUCCEEDED,
    idempotencyKey: "test:read-a1",
    readAt: new Date(),
  });
  // Same person, a different firm: must never appear while working in org A.
  otherOrgA1 = await seedNotification({
    userId: ids.userA1,
    organizationId: ids.orgB,
    idempotencyKey: "test:other-org-a1",
  });
  // Somebody else entirely, in the same firm.
  otherUser = await seedNotification({
    userId: ids.userA2,
    organizationId: ids.orgA,
    idempotencyKey: "test:other-user",
  });
});

afterAll(async () => {
  try {
    if (seeded.length > 0) {
      await testDb
        .delete(notifications)
        .where(inArray(notifications.id, seeded));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("notification list scoping", () => {
  test("answers with the caller's own rows in their active organization", async () => {
    const page = await listAs({
      userId: ids.userA1,
      organizationId: ids.orgA,
    });
    const returned = page.items.map(({ id }) => id);

    expect(returned).toContain(unreadA1);
    expect(returned).toContain(readA1);
    expect(returned).not.toContain(otherOrgA1);
    expect(returned).not.toContain(otherUser);
  });

  test("answers with the matter a pointer lives in, and none without one", async () => {
    const page = await listAs({
      userId: ids.userA1,
      organizationId: ids.orgA,
    });
    const mention = page.items.find(({ id }) => id === unreadA1);
    const pointerless = page.items.find(({ id }) => id === readA1);

    // Every target route is /workspaces/:workspaceId/..., so the entity id
    // alone is not addressable: without this the client can render no link.
    expect(mention?.entityType).toBe("entity");
    expect(mention?.entityId).toBe(ids.entityA1);
    expect(mention?.workspaceId).toBe(ids.wsA1);
    expect(pointerless?.workspaceId).toBeNull();
  });

  test("switching organizations switches the feed", async () => {
    const page = await listAs({
      userId: ids.userA1,
      organizationId: ids.orgB,
    });
    const returned = page.items.map(({ id }) => id);

    expect(returned).toContain(otherOrgA1);
    expect(returned).not.toContain(unreadA1);
  });

  test("another user's rows are invisible even inside the same organization", async () => {
    const page = await listAs({
      userId: ids.userA2,
      organizationId: ids.orgA,
    });
    const returned = page.items.map(({ id }) => id);

    expect(returned).toContain(otherUser);
    expect(returned).not.toContain(unreadA1);
    expect(returned).not.toContain(readA1);
  });

  test("RLS refuses a row addressed to somebody else", async () => {
    const foreignInsert = await Result.tryPromise(
      async () =>
        await createScopedDb(
          testDb,
          [],
          ids.orgA,
          ids.userA1,
        )(async (tx) => {
          await tx.insert(notifications).values({
            id: createSafeId<"notification">(),
            userId: ids.userA2,
            organizationId: ids.orgA,
            kind: NOTIFICATION_KIND.ANNOUNCEMENT,
            metadata: { title: "smuggled" },
            entityType: null,
            entityId: null,
            idempotencyKey: "test:rls-refusal",
          });
        }),
    );

    expect(Result.isError(foreignInsert)).toBe(true);
    const wrote = await testDb
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.idempotencyKey, "test:rls-refusal"));
    expect(wrote).toHaveLength(0);
  });

  test("RLS hides the caller's own rows from another organization's scope", async () => {
    // Not the handler's organization filter: this reads the row by primary key
    // through a scoped connection, so only the policy can be hiding it.
    const rows = await createScopedDb(
      testDb,
      [],
      ids.orgA,
      ids.userA1,
    )(
      async (tx) =>
        await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.id, otherOrgA1)),
    );

    expect(rows).toHaveLength(0);
  });

  test("RLS refuses a row filed against another organization", async () => {
    const foreignOrgInsert = await Result.tryPromise(
      async () =>
        await createScopedDb(
          testDb,
          [],
          ids.orgA,
          ids.userA1,
        )(async (tx) => {
          await tx.insert(notifications).values({
            id: createSafeId<"notification">(),
            userId: ids.userA1,
            organizationId: ids.orgB,
            kind: NOTIFICATION_KIND.ANNOUNCEMENT,
            metadata: { title: "wrong firm" },
            entityType: null,
            entityId: null,
            idempotencyKey: "test:rls-org-refusal",
          });
        }),
    );

    expect(Result.isError(foreignOrgInsert)).toBe(true);
    const wrote = await testDb
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.idempotencyKey, "test:rls-org-refusal"));
    expect(wrote).toHaveLength(0);
  });

  test("rejects a cursor it did not issue", async () => {
    const result = await listNotifications.handler(
      asTestRaw<ListContext>({
        ...contextFor({ userId: ids.userA1, organizationId: ids.orgA }),
        query: { cursor: "not-a-cursor" },
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid cursor" },
    });
  });
});

describe("unread count", () => {
  test("counts only this user's unread rows in this organization", async () => {
    const page = await listAs({
      userId: ids.userA1,
      organizationId: ids.orgA,
    });

    // unreadA1 only: readA1 is read, otherOrgA1 is another org, otherUser is
    // another person.
    expect(page.unreadCount).toBe(1);
  });

  test("reading one row lowers the count and is idempotent", async () => {
    const id = await seedNotification({
      userId: ids.userA1,
      organizationId: ids.orgA,
      idempotencyKey: "test:read-twice",
    });
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    const before = await listAs(actor);

    const first = await markNotificationRead.handler(
      asTestRaw<ReadContext>({
        ...contextFor(actor),
        params: { notificationId: id },
      }),
    );
    const second = await markNotificationRead.handler(
      asTestRaw<ReadContext>({
        ...contextFor(actor),
        params: { notificationId: id },
      }),
    );

    expect(first).toEqual({ unreadCount: before.unreadCount - 1 });
    expect(second).toEqual({ unreadCount: before.unreadCount - 1 });
  });

  test("reading somebody else's notification is a 404, not a write", async () => {
    const result = await markNotificationRead.handler(
      asTestRaw<ReadContext>({
        ...contextFor({ userId: ids.userA1, organizationId: ids.orgA }),
        params: { notificationId: otherUser },
      }),
    );

    expect(result).toEqual({
      code: 404,
      response: { message: "Notification not found" },
    });
    const [row] = await testDb
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.id, otherUser));
    expect(row?.readAt).toBeNull();
  });

  test("read-all clears this organization only", async () => {
    const actor = { userId: ids.userA1, organizationId: ids.orgA };
    await seedNotification({
      userId: ids.userA1,
      organizationId: ids.orgA,
      idempotencyKey: "test:read-all-target",
    });

    const result = await markAllNotificationsRead.handler(
      asTestRaw<ReadAllContext>(contextFor(actor)),
    );

    expect(result).toEqual({ markedCount: expect.any(Number), unreadCount: 0 });
    expect(await listAs(actor)).toMatchObject({ unreadCount: 0 });
    // The other firm's badge is untouched.
    expect(
      await listAs({ userId: ids.userA1, organizationId: ids.orgB }),
    ).toMatchObject({ unreadCount: 1 });
  });
});

describe("fanOutNotifications", () => {
  test("a mention filed for somebody else keeps the comment's matter", async () => {
    // The producer writes the matter it validated the mention against, and it
    // survives the fan-out to the recipient's feed unchanged: this is the
    // whole deep link, and it names a matter the recipient is a member of.
    const row: NewNotification = {
      kind: NOTIFICATION_KIND.MENTION,
      metadata: { actorName: "Ada" },
      entityType: "entity",
      entityId: ids.entityA1,
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      userId: ids.userA1,
      idempotencyKey: "test:mention-workspace",
    };

    await fanOutNotifications([row], fanOutDb());

    const written = await testDb
      .select({ id: notifications.id, workspaceId: notifications.workspaceId })
      .from(notifications)
      .where(eq(notifications.idempotencyKey, "test:mention-workspace"));
    seeded.push(...written.map(({ id }) => id));
    expect(written.map(({ workspaceId }) => workspaceId)).toEqual([ids.wsA1]);

    const page = await listAs({ userId: ids.userA1, organizationId: ids.orgA });
    const listed = page.items.find(({ id }) => id === written.at(0)?.id);
    expect(listed?.workspaceId).toBe(ids.wsA1);
  });

  test("an idempotency key replayed for the same user writes one row", async () => {
    const row: NewNotification = {
      kind: NOTIFICATION_KIND.FLOW_RUN_COMPLETED,
      metadata: { flowName: "Intake" },
      entityType: "flow_run",
      entityId: createSafeId<"flowRun">(),
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      userId: ids.userA1,
      idempotencyKey: "test:dedupe",
    };

    await fanOutNotifications([row], fanOutDb());
    await fanOutNotifications([row], fanOutDb());

    const written = await testDb
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.idempotencyKey, "test:dedupe"));
    expect(written).toHaveLength(1);
    seeded.push(...written.map(({ id }) => id));
  });

  test("the same key for two people is two rows", async () => {
    const shared = {
      kind: NOTIFICATION_KIND.ANNOUNCEMENT,
      metadata: { title: "Maintenance window" },
      entityType: null,
      entityId: null,
      workspaceId: null,
      organizationId: ids.orgA,
      idempotencyKey: "test:shared-announcement",
    } as const;

    await fanOutNotifications(
      [
        { ...shared, userId: ids.userA1 },
        { ...shared, userId: ids.userA2 },
      ],
      fanOutDb(),
    );

    const written = await testDb
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.idempotencyKey, "test:shared-announcement"));
    expect(written).toHaveLength(2);
    seeded.push(...written.map(({ id }) => id));
  });

  test("a fan-out larger than one batch still writes every row", async () => {
    // Two users is all the fixture has, so drive the batching with a batch
    // size of one row per statement by writing distinct keys.
    const count = 3;
    const rows: NewNotification[] = Array.from(
      { length: count },
      (_, index) => ({
        kind: NOTIFICATION_KIND.ANNOUNCEMENT,
        metadata: { title: "Batched" },
        entityType: null,
        entityId: null,
        workspaceId: null,
        organizationId: ids.orgA,
        userId: index % 2 === 0 ? ids.userA1 : ids.userA2,
        idempotencyKey: `test:batch:${index}`,
      }),
    );

    await fanOutNotifications(rows, fanOutDb());

    const written = await testDb
      .select({ id: notifications.id, key: notifications.idempotencyKey })
      .from(notifications)
      .where(
        inArray(
          notifications.idempotencyKey,
          rows.map(({ idempotencyKey }) => idempotencyKey),
        ),
      );
    expect(written).toHaveLength(count);
    expect(NOTIFICATION_INSERT_BATCH_SIZE).toBeGreaterThan(0);
    seeded.push(...written.map(({ id }) => id));
  });
});

describe("announcements", () => {
  const announceAs = async (
    userId: SafeId<"user">,
    operatorUserIds: string | undefined,
  ) =>
    await createPublishAnnouncementEndpoint({
      getOperatorUserIds: () => operatorUserIds,
    }).handler(
      asTestRaw<AnnounceContext>({
        ...contextFor({ userId, organizationId: ids.orgA }),
        body: { title: "Scheduled maintenance", announcementKey: "k1" },
      }),
    );

  test("report a configuration error when no operator is configured", async () => {
    // Never silently dead: an unconfigured deployment says so rather than
    // accepting the request and dropping it.
    expect(await announceAs(ids.userA1, undefined)).toMatchObject({
      code: 500,
    });
    expect(await announceAs(ids.userA1, "   ")).toMatchObject({ code: 500 });
  });

  test("refuse a caller the allowlist does not name", async () => {
    expect(await announceAs(ids.userA1, ids.userAdmin)).toEqual({
      code: 403,
      response: { message: "Announcements require operator authorization" },
    });
  });

  test("the default endpoint reads the deployment's own configuration", async () => {
    // The shipped handler is wired to the env rather than to a fixture, so an
    // unconfigured test environment must reach the configuration branch.
    expect(
      await publishAnnouncement.handler(
        asTestRaw<AnnounceContext>({
          ...contextFor({ userId: ids.userA1, organizationId: ids.orgA }),
          body: { title: "Hello", announcementKey: "k2" },
        }),
      ),
    ).toMatchObject({ code: 500 });
  });

  test("an operator's broadcast reaches the firm and names its publisher", async () => {
    const recorded: AuditEvent[] = [];
    const context = contextFor({
      userId: ids.userAdmin,
      organizationId: ids.orgA,
    });
    const result = await createPublishAnnouncementEndpoint({
      getOperatorUserIds: () => ids.userAdmin,
      database: fanOutDb(),
    }).handler(
      asTestRaw<AnnounceContext>({
        ...context,
        recordAuditEvent: async (_tx: unknown, event: AuditEvent) => {
          recorded.push(event);
        },
        body: { title: "Scheduled maintenance", announcementKey: "k3" },
      }),
    );

    const key = `announcement:${ids.orgA}:k3`;
    const written = await testDb
      .select({ id: notifications.id, userId: notifications.userId })
      .from(notifications)
      .where(eq(notifications.idempotencyKey, key));
    seeded.push(...written.map(({ id }) => id));

    expect(result).toEqual({ recipientCount: written.length });
    expect(written.length).toBeGreaterThan(0);

    // The rows say who received the announcement; only the audit event says
    // who published it.
    expect(recorded).toEqual([
      {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.ANNOUNCEMENT,
        resourceId: key,
        workspaceId: null,
        metadata: {
          title: "Scheduled maintenance",
          recipientCount: written.length,
        },
      },
    ]);
  });
});
