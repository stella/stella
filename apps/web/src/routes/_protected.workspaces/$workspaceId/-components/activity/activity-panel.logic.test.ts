import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type { MatterActivityItem } from "@/routes/_protected.workspaces/-queries";

import { activityDayKey, groupActivityItems } from "./activity-panel.logic";

type ItemOptions = {
  action?: MatterActivityItem["action"];
  activityAt?: string;
  performer?: MatterActivityItem["performer"];
  runId: string | null;
};

const item = (
  id: string,
  {
    action = "update",
    activityAt = "2026-07-30T12:00:00.000Z",
    performer = { name: "Review agent", type: "agent" },
    runId,
  }: ItemOptions,
): MatterActivityItem => ({
  action,
  activityAt,
  approval: { status: "not_required", user: null },
  category: "documents",
  id: toSafeId<"auditLog">(id),
  performer,
  runId,
  target: {
    deleted: false,
    encrypted: false,
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

describe("groupActivityItems", () => {
  test("groups only consecutive events from the same AI run", () => {
    const groups = groupActivityItems([
      item("1", { runId: "run-a" }),
      item("2", { runId: "run-a" }),
      item("3", { runId: null }),
      item("4", { runId: "run-a" }),
    ]);

    expect(
      groups.map((group) => group.items.map(({ id }) => String(id))),
    ).toEqual([["1", "2"], ["3"], ["4"]]);
    expect(new Set(groups.map(({ id }) => id)).size).toBe(groups.length);
  });

  test("groups fifty document uploads by one person within one minute", () => {
    const anchor = new Date("2026-07-30T12:00:00.000Z").getTime();
    const performer = {
      deletedAt: null,
      image: null,
      name: "Matter Administrator",
      type: "user",
    } satisfies MatterActivityItem["performer"];
    const uploads = Array.from({ length: 50 }, (_, index) =>
      item(String(index), {
        action: "create",
        activityAt: new Date(anchor - index * 1000).toISOString(),
        performer,
        runId: null,
      }),
    );

    const groups = groupActivityItems(uploads);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.type).toBe("document_batch");
    expect(groups[0]?.items).toHaveLength(50);
  });

  test("starts a new document batch outside the first item's minute", () => {
    const performer = {
      deletedAt: null,
      image: null,
      name: "Matter Administrator",
      type: "user",
    } satisfies MatterActivityItem["performer"];
    const groups = groupActivityItems([
      item("1", {
        action: "create",
        activityAt: "2026-07-30T12:01:00.000Z",
        performer,
        runId: null,
      }),
      item("2", {
        action: "create",
        activityAt: "2026-07-30T12:00:01.000Z",
        performer,
        runId: null,
      }),
      item("3", {
        action: "create",
        activityAt: "2026-07-30T11:59:59.999Z",
        performer,
        runId: null,
      }),
    ]);

    expect(groups.map(({ items }) => items.length)).toEqual([2, 1]);
  });

  test("keeps uploads in one batch when the minute crosses midnight", () => {
    const performer = {
      deletedAt: null,
      image: null,
      name: "Matter Administrator",
      type: "user",
    } satisfies MatterActivityItem["performer"];
    const groups = groupActivityItems([
      item("1", {
        action: "create",
        activityAt: "2026-07-31T00:00:20.000Z",
        performer,
        runId: null,
      }),
      item("2", {
        action: "create",
        activityAt: "2026-07-30T23:59:40.000Z",
        performer,
        runId: null,
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items).toHaveLength(2);
  });

  test("uses local calendar days instead of UTC slices", () => {
    expect(activityDayKey("2026-07-30T12:00:00.000Z")).toBe(
      activityDayKey("2026-07-30T18:00:00.000Z"),
    );
  });
});
