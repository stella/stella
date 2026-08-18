import { mock } from "bun:test";

let activeTestDb: any;
const rootDbProxy = new Proxy({} as any, {
  get(_, prop, receiver) {
    if (!activeTestDb) {
      throw new Error("activeTestDb is not initialized yet!");
    }
    return Reflect.get(activeTestDb, prop, receiver);
  },
});

void mock.module("@/api/db/root", () => ({
  rootDb: rootDbProxy,
}));

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { user as authUser } from "@/api/db/auth-schema";
import { notifications } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import { createSafeDb } from "@/api/db/scoped";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import listNotifications from "./list";
import markNotificationRead from "./read";
import markAllNotificationsRead from "./read-all";
import publishProductNews from "./product-news";
import { createNotification } from "@/api/lib/notifications";

setDefaultTimeout(120_000);

type ListNotifications = typeof listNotifications;
type ListNotificationsCtx = Parameters<ListNotifications["handler"]>[0];

type MarkRead = typeof markNotificationRead;
type MarkReadCtx = Parameters<MarkRead["handler"]>[0];

type MarkAllRead = typeof markAllNotificationsRead;
type MarkAllReadCtx = Parameters<MarkAllRead["handler"]>[0];

type ProductNews = typeof publishProductNews;
type ProductNewsCtx = Parameters<ProductNews["handler"]>[0];

const userId = toSafeId<"user">(`notif-test-${Bun.randomUUIDv7()}`);
const otherUserId = toSafeId<"user">(`notif-test-other-${Bun.randomUUIDv7()}`);
const orgId = toSafeId<"organization">(`notif-org-${Bun.randomUUIDv7()}`);

beforeAll(async () => {
  activeTestDb = await getTestDb();
  await activeTestDb.insert(authUser).values([
    {
      id: userId,
      email: `${userId}@example.test`,
      name: "Notif User 1",
    },
    {
      id: otherUserId,
      email: `${otherUserId}@example.test`,
      name: "Notif User 2",
    },
  ]);
});

afterAll(async () => {
  if (activeTestDb) {
    await activeTestDb.delete(notifications).where(eq(notifications.userId, userId));
    await activeTestDb.delete(notifications).where(eq(notifications.userId, otherUserId));
    await activeTestDb.delete(authUser).where(eq(authUser.id, userId));
    await activeTestDb.delete(authUser).where(eq(authUser.id, otherUserId));
  }
  await releaseTestDb();
});

describe("notifications backend logic", () => {
  test("creates notifications and lists them for the authenticated user", async () => {
    // 1. Create a notification
    const notifId = await createNotification(activeTestDb, {
      userId,
      title: "Test Alert",
      message: "This is a test notification",
      entityType: "document",
      entityId: "doc-123",
    });

    expect(notifId).toBeDefined();

    // 2. List notifications for user
    const page = await listNotifications.handler(
      createTestHandlerContext<ListNotificationsCtx>({
        safeDb: asTestRaw<any>(createSafeDb(activeTestDb, [], orgId, userId)),
        user: { id: userId },
        query: {},
      })
    );

    expect(page).toBeDefined();
    expect("items" in page).toBe(true);
    if ("items" in page) {
      expect(page.items.length).toBe(1);
      const item = page.items[0];
      expect(item).toBeDefined();
      if (item) {
        expect(item.id).toBe(notifId);
        expect(item.title).toBe("Test Alert");
        expect(item.message).toBe("This is a test notification");
        expect(item.isRead).toBe(false);
        expect(item.entityType).toBe("document");
        expect(item.entityId).toBe("doc-123");
      }
    }
  });

  test("marks a single notification as read", async () => {
    const notifId = await createNotification(activeTestDb, {
      userId,
      title: "Mark Read Alert",
      message: "Unread message",
    });

    const readResult = await markNotificationRead.handler(
      createTestHandlerContext<MarkReadCtx>({
        safeDb: asTestRaw<any>(createSafeDb(activeTestDb, [], orgId, userId)),
        user: { id: userId },
        params: { notificationId: notifId },
      })
    );

    expect(readResult).toBeDefined();
    expect("status" in readResult).toBe(false);

    const page = await listNotifications.handler(
      createTestHandlerContext<ListNotificationsCtx>({
        safeDb: asTestRaw<any>(createSafeDb(activeTestDb, [], orgId, userId)),
        user: { id: userId },
        query: {},
      })
    );

    if ("items" in page) {
      const match = page.items.find((n: any) => n.id === notifId);
      expect(match?.isRead).toBe(true);
      expect(match?.readAt).not.toBeNull();
    }
  });

  test("marks all notifications as read", async () => {
    await createNotification(activeTestDb, {
      userId,
      title: "Bulk Alert 1",
      message: "Message 1",
    });
    await createNotification(activeTestDb, {
      userId,
      title: "Bulk Alert 2",
      message: "Message 2",
    });

    const readAllResult = await markAllNotificationsRead.handler(
      createTestHandlerContext<MarkAllReadCtx>({
        safeDb: asTestRaw<any>(createSafeDb(activeTestDb, [], orgId, userId)),
        user: { id: userId },
      })
    );

    expect(readAllResult).toBeDefined();
    expect("status" in readAllResult).toBe(false);

    const page = await listNotifications.handler(
      createTestHandlerContext<ListNotificationsCtx>({
        safeDb: asTestRaw<any>(createSafeDb(activeTestDb, [], orgId, userId)),
        user: { id: userId },
        query: {},
      })
    );

    if ("items" in page) {
      const unread = page.items.filter((n: any) => !n.isRead);
      expect(unread.length).toBe(0);
    }
  });

  test("publishes product news to all users", async () => {
    const newsResult = await publishProductNews.handler(
      createTestHandlerContext<ProductNewsCtx>({
        safeDb: asTestRaw<any>(createSafeDb(activeTestDb, [], orgId, userId)),
        body: {
          title: "Product Launch",
          message: "Stella v2.0 is live!",
        },
      })
    );

    expect(newsResult).toBeDefined();
    expect("status" in newsResult).toBe(false);

    const userPage = await listNotifications.handler(
      createTestHandlerContext<ListNotificationsCtx>({
        safeDb: asTestRaw<any>(createSafeDb(activeTestDb, [], orgId, userId)),
        user: { id: userId },
        query: {},
      })
    );

    const otherPage = await listNotifications.handler(
      createTestHandlerContext<ListNotificationsCtx>({
        safeDb: asTestRaw<any>(createSafeDb(activeTestDb, [], orgId, otherUserId)),
        user: { id: otherUserId },
        query: {},
      })
    );

    if ("items" in userPage && "items" in otherPage) {
      const userNews = userPage.items.find((n: any) => n.title === "Product Launch");
      const otherNews = otherPage.items.find((n: any) => n.title === "Product Launch");

      expect(userNews).toBeDefined();
      expect(otherNews).toBeDefined();
      expect(userNews?.message).toBe("Stella v2.0 is live!");
      expect(otherNews?.message).toBe("Stella v2.0 is live!");
    }
  });
});
