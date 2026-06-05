import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { buildExpiryAuditEvents } from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry-audit";
import {
  publishDesktopEditSessionExpiryNotifications,
  type ExpiredDesktopEditSessionNotification,
} from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry-notifications";
import type { SSEEvent } from "@/api/lib/sse-broadcast";

const session = (id: string, createdBy: string) => ({
  id,
  workspaceId: toSafeId<"workspace">("019e0000-0000-7000-8000-00000000ws01"),
  organizationId: toSafeId<"organization">(
    "019e0000-0000-7000-8000-0000000org1",
  ),
  createdBy,
});

describe("buildExpiryAuditEvents", () => {
  test("audits only sessions the UPDATE actually transitioned", () => {
    const sessions = [
      session("s1", "user-1"),
      session("s2", "user-2"),
      session("s3", "user-3"),
    ];

    const events = buildExpiryAuditEvents(sessions, new Set(["s1", "s3"]));

    expect(events.map((event) => event.resourceId)).toEqual(["s1", "s3"]);
  });

  test("emits no events when nothing transitioned", () => {
    const events = buildExpiryAuditEvents([session("s1", "user-1")], new Set());

    expect(events).toEqual([]);
  });

  test("records the open->expired diff attributed to the lock holder", () => {
    const [event] = buildExpiryAuditEvents(
      [session("s1", "user-1")],
      new Set(["s1"]),
    );

    expect(event).toEqual({
      organizationId: toSafeId<"organization">(
        "019e0000-0000-7000-8000-0000000org1",
      ),
      workspaceId: toSafeId<"workspace">(
        "019e0000-0000-7000-8000-00000000ws01",
      ),
      userId: "user-1",
      action: "update",
      resourceType: "desktop_edit_session",
      resourceId: "s1",
      changes: { status: { old: "open", new: "expired" } },
      metadata: { reason: "token_expired" },
    });
  });
});

type PublishedEvent = {
  scope: "session" | "workspace";
  id: string;
  event: SSEEvent;
};

const notificationSession = (
  id: string,
  workspaceId: string,
): ExpiredDesktopEditSessionNotification => ({
  id: toSafeId<"desktopEditSession">(id),
  workspaceId: toSafeId<"workspace">(workspaceId),
});

describe("publishDesktopEditSessionExpiryNotifications", () => {
  test("publishes session close events and one invalidation per workspace", async () => {
    const published: PublishedEvent[] = [];

    await publishDesktopEditSessionExpiryNotifications({
      publisher: {
        publishSessionEvent: async (sessionId, event) => {
          published.push({ scope: "session", id: sessionId, event });
        },
        publishWorkspaceEvent: async (workspaceId, event) => {
          published.push({ scope: "workspace", id: workspaceId, event });
        },
      },
      sessions: [
        notificationSession("session-1", "workspace-1"),
        notificationSession("session-2", "workspace-1"),
      ],
    });

    expect(published).toContainEqual({
      scope: "session",
      id: "session-1",
      event: { type: "session-closed", data: { reason: "expired" } },
    });
    expect(published).toContainEqual({
      scope: "session",
      id: "session-1",
      event: { type: "__desktop_edit_session_closed__", data: null },
    });
    expect(published).toContainEqual({
      scope: "session",
      id: "session-2",
      event: { type: "session-closed", data: { reason: "expired" } },
    });
    expect(published).toContainEqual({
      scope: "session",
      id: "session-2",
      event: { type: "__desktop_edit_session_closed__", data: null },
    });
    expect(published.filter((event) => event.scope === "workspace")).toEqual([
      {
        scope: "workspace",
        id: "workspace-1",
        event: {
          type: "invalidate-query",
          data: ["entities", "workspace-1"],
        },
      },
    ]);
  });

  test("propagates publish failures so callers can retry", async () => {
    await expect(
      publishDesktopEditSessionExpiryNotifications({
        publisher: {
          publishSessionEvent: async () => {
            throw new Error("publish failed");
          },
          publishWorkspaceEvent: async () => undefined,
        },
        sessions: [notificationSession("session-1", "workspace-1")],
      }),
    ).rejects.toThrow("publish failed");
  });
});
