import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type { MatterActivityItem } from "@/lib/workspaces/queries";

import {
  activityDayKey,
  expandActivityGroupsForList,
  groupActivityItems,
  resolveVisibleActivityTriggerType,
  resolveSelectedActivityGroup,
} from "./activity-panel.logic";

const LOCAL_NOON = new Date(2026, 6, 30, 12).getTime();
const LOCAL_MIDNIGHT = new Date(2026, 6, 31).getTime();

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

describe("activity provenance", () => {
  test("hides direct activity and retains exceptional trigger types", () => {
    const triggerTypes = [
      "direct",
      "user_dispatch",
      "agent_delegation",
      "schedule",
      "webhook",
      "credential",
      "system",
    ] as const satisfies readonly MatterActivityItem["trigger"]["type"][];

    expect(triggerTypes.map(resolveVisibleActivityTriggerType)).toEqual([
      null,
      "user_dispatch",
      "agent_delegation",
      "schedule",
      "webhook",
      "credential",
      "system",
    ]);
  });
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
      id: "user-1",
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
      id: "user-1",
      image: null,
      name: "Matter Administrator",
      type: "user",
    } satisfies MatterActivityItem["performer"];
    const groups = groupActivityItems([
      item("1", {
        action: "create",
        activityAt: new Date(LOCAL_NOON + 60_000).toISOString(),
        performer,
        runId: null,
      }),
      item("2", {
        action: "create",
        activityAt: new Date(LOCAL_NOON + 1000).toISOString(),
        performer,
        runId: null,
      }),
      item("3", {
        action: "create",
        activityAt: new Date(LOCAL_NOON - 1).toISOString(),
        performer,
        runId: null,
      }),
    ]);

    expect(groups.map(({ items }) => items.length)).toEqual([2, 1]);
  });

  test("splits upload batches at local midnight", () => {
    const performer = {
      deletedAt: null,
      id: "user-1",
      image: null,
      name: "Matter Administrator",
      type: "user",
    } satisfies MatterActivityItem["performer"];
    const groups = groupActivityItems([
      item("1", {
        action: "create",
        activityAt: new Date(LOCAL_MIDNIGHT + 20_000).toISOString(),
        performer,
        runId: null,
      }),
      item("2", {
        action: "create",
        activityAt: new Date(LOCAL_MIDNIGHT - 20_000).toISOString(),
        performer,
        runId: null,
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map(({ items }) => items.length)).toEqual([1, 1]);
  });

  test("splits automation runs at local midnight", () => {
    const groups = groupActivityItems([
      item("1", {
        activityAt: new Date(LOCAL_MIDNIGHT + 20_000).toISOString(),
        runId: "run-a",
      }),
      item("2", {
        activityAt: new Date(LOCAL_MIDNIGHT - 20_000).toISOString(),
        runId: "run-a",
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map(({ items }) => items.length)).toEqual([1, 1]);
  });

  test("keeps same-named users in separate upload batches", () => {
    const performer = {
      deletedAt: null,
      image: null,
      name: "Matter Administrator",
      type: "user",
    } as const;
    const groups = groupActivityItems([
      item("1", {
        action: "create",
        performer: { ...performer, id: "user-1" },
        runId: null,
      }),
      item("2", {
        action: "create",
        performer: { ...performer, id: "user-2" },
        runId: null,
      }),
    ]);

    expect(groups).toHaveLength(2);
  });

  test("expands every automation event for list mode", () => {
    const groups = groupActivityItems([
      item("1", { runId: "run-a" }),
      item("2", { runId: "run-a" }),
    ]);

    expect(
      expandActivityGroupsForList(groups).map(({ items }) => items[0].id),
    ).toEqual([toSafeId<"auditLog">("1"), toSafeId<"auditLog">("2")]);
  });

  test("resolves an individual event inside an automation run", () => {
    const groups = groupActivityItems([
      item("1", { runId: "run-a" }),
      item("2", { runId: "run-a" }),
    ]);

    const selectedGroup = resolveSelectedActivityGroup(groups, "item:2");

    expect(selectedGroup?.type).toBe("single");
    expect(selectedGroup?.items[0].id).toBe(toSafeId<"auditLog">("2"));
  });

  test("uses local calendar days instead of UTC slices", () => {
    expect(activityDayKey("2026-07-30T12:00:00.000Z")).toBe(
      activityDayKey("2026-07-30T18:00:00.000Z"),
    );
  });
});
