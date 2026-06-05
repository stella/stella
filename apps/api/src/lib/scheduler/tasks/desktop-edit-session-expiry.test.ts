import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { buildExpiryAuditEvents } from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry-audit";

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
