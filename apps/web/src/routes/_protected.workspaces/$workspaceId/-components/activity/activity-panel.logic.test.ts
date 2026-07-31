import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type { MatterActivityItem } from "@/routes/_protected.workspaces/-queries";

import { activityDayKey, groupActivityRuns } from "./activity-panel.logic";

const item = (id: string, runId: string | null): MatterActivityItem => ({
  action: "update",
  activityAt: "2026-07-30T12:00:00.000Z",
  approval: { status: "not_required", user: null },
  category: "documents",
  id: toSafeId<"auditLog">(id),
  performer: { name: "Review agent", type: "agent" },
  runId,
  target: {
    deleted: false,
    entityId: "entity-1",
    fieldId: "field-1",
    id: "entity-1",
    kind: "document",
    mimeType: "application/pdf",
    name: "Agreement.pdf",
    pdfFileId: null,
    propertyId: "property-1",
  },
  trigger: {
    source: "chat",
    type: "user_dispatch",
    user: null,
  },
});

describe("groupActivityRuns", () => {
  test("groups only consecutive events from the same AI run", () => {
    const groups = groupActivityRuns([
      item("1", "run-a"),
      item("2", "run-a"),
      item("3", null),
      item("4", "run-a"),
    ]);

    expect(
      groups.map((group) => group.items.map(({ id }) => String(id))),
    ).toEqual([["1", "2"], ["3"], ["4"]]);
    expect(new Set(groups.map(({ id }) => id)).size).toBe(groups.length);
  });

  test("uses local calendar days instead of UTC slices", () => {
    expect(activityDayKey("2026-07-30T12:00:00.000Z")).toBe(
      activityDayKey("2026-07-30T18:00:00.000Z"),
    );
  });
});
