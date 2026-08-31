import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type { MatterActivityItem } from "@/lib/workspaces/queries";

import {
  activityDayKey,
  expandActivityGroupsForList,
  groupActivityItems,
  resolveSelectedActivityGroup,
  resolveVisibleActivityTriggerType,
  ROW_ACTION_LABEL_KEYS,
  TARGET_LABEL_KEYS,
  toMatterActivityDateRange,
} from "./activity-panel.logic";

describe("toMatterActivityDateRange", () => {
  test("uses local calendar boundaries and an exclusive end day", () => {
    const range = toMatterActivityDateRange({
      from: "2026-08-01",
      to: "2026-08-13",
    });
    expect(new Date(range.from ?? "").getDate()).toBe(1);
    expect(new Date(range.toExclusive ?? "").getDate()).toBe(14);
  });

  test("preserves open date bounds", () => {
    expect(toMatterActivityDateRange({ from: null, to: null })).toEqual({
      from: null,
      toExclusive: null,
    });
  });
});

const LOCAL_NOON = new Date(2026, 6, 30, 12).getTime();
const LOCAL_MIDNIGHT = new Date(2026, 6, 31).getTime();

type ItemOptions = {
  action?: MatterActivityItem["action"];
  activityAt?: string;
  performer?: MatterActivityItem["performer"];
  renameOnly?: boolean;
  runId: string | null;
  target?: Partial<MatterActivityItem["target"]>;
};

const item = (
  id: string,
  {
    action = "update",
    activityAt = "2026-07-30T12:00:00.000Z",
    performer = { name: "Review agent", type: "agent" },
    renameOnly = false,
    runId,
    target,
  }: ItemOptions,
): MatterActivityItem => ({
  action,
  activityAt,
  approval: { status: "not_required", user: null },
  category: "documents",
  id: toSafeId<"auditLog">(id),
  performer,
  renameOnly,
  runId,
  target: {
    color: null,
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
    ...target,
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

  test("folds a folder's immediate renames into its create entry", () => {
    const performer = {
      deletedAt: null,
      id: "user-1",
      image: null,
      name: "Matter Administrator",
      type: "user",
    } satisfies MatterActivityItem["performer"];
    const folder = { id: "folder-1", kind: "folder", mimeType: null } as const;
    // Newest first, as the API returns them.
    const groups = groupActivityItems([
      item("3", {
        activityAt: new Date(LOCAL_NOON + 8000).toISOString(),
        performer,
        renameOnly: true,
        runId: null,
        target: folder,
      }),
      item("2", {
        activityAt: new Date(LOCAL_NOON + 5000).toISOString(),
        performer,
        renameOnly: true,
        runId: null,
        target: folder,
      }),
      item("1", {
        action: "create",
        activityAt: new Date(LOCAL_NOON).toISOString(),
        performer,
        runId: null,
        target: folder,
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map(({ action }) => action)).toEqual(["create"]);
  });

  test("keeps a folder move recorded right after the creation", () => {
    const performer = {
      deletedAt: null,
      id: "user-1",
      image: null,
      name: "Matter Administrator",
      type: "user",
    } satisfies MatterActivityItem["performer"];
    const folder = { id: "folder-1", kind: "folder", mimeType: null } as const;
    const groups = groupActivityItems([
      // A move is an update whose change set is not just the name.
      item("2", {
        activityAt: new Date(LOCAL_NOON + 5000).toISOString(),
        performer,
        renameOnly: false,
        runId: null,
        target: folder,
      }),
      item("1", {
        action: "create",
        activityAt: new Date(LOCAL_NOON).toISOString(),
        performer,
        runId: null,
        target: folder,
      }),
    ]);

    expect(groups).toHaveLength(2);
  });

  test("keeps folder updates that are not part of the creation", () => {
    const performer = {
      deletedAt: null,
      id: "user-1",
      image: null,
      name: "Matter Administrator",
      type: "user",
    } satisfies MatterActivityItem["performer"];
    const folder = { id: "folder-1", kind: "folder", mimeType: null } as const;
    const differentFolder = groupActivityItems([
      item("2", {
        activityAt: new Date(LOCAL_NOON + 2000).toISOString(),
        performer,
        renameOnly: true,
        runId: null,
        target: { ...folder, id: "folder-2" },
      }),
      item("1", {
        action: "create",
        activityAt: new Date(LOCAL_NOON).toISOString(),
        performer,
        runId: null,
        target: folder,
      }),
    ]);
    expect(differentFolder).toHaveLength(2);

    const differentPerformer = groupActivityItems([
      item("2", {
        activityAt: new Date(LOCAL_NOON + 2000).toISOString(),
        performer: { ...performer, id: "user-2" },
        renameOnly: true,
        runId: null,
        target: folder,
      }),
      item("1", {
        action: "create",
        activityAt: new Date(LOCAL_NOON).toISOString(),
        performer,
        runId: null,
        target: folder,
      }),
    ]);
    expect(differentPerformer).toHaveLength(2);
  });

  test("keeps a folder rename outside the creation window", () => {
    const performer = {
      deletedAt: null,
      id: "user-1",
      image: null,
      name: "Matter Administrator",
      type: "user",
    } satisfies MatterActivityItem["performer"];
    const folder = { id: "folder-1", kind: "folder", mimeType: null } as const;
    const groups = groupActivityItems([
      item("2", {
        activityAt: new Date(LOCAL_NOON + 61_000).toISOString(),
        performer,
        renameOnly: true,
        runId: null,
        target: folder,
      }),
      item("1", {
        action: "create",
        activityAt: new Date(LOCAL_NOON).toISOString(),
        performer,
        runId: null,
        target: folder,
      }),
    ]);

    expect(groups).toHaveLength(2);
  });

  test("keeps folder creates out of document upload batches", () => {
    const performer = {
      deletedAt: null,
      id: "user-1",
      image: null,
      name: "Matter Administrator",
      type: "user",
    } satisfies MatterActivityItem["performer"];
    const groups = groupActivityItems([
      item("1", { action: "create", performer, runId: null }),
      item("2", {
        action: "create",
        performer,
        runId: null,
        target: { id: "folder-1", kind: "folder", mimeType: null },
      }),
      item("3", { action: "create", performer, runId: null }),
    ]);

    expect(groups.map(({ type }) => type)).toEqual([
      "document_batch",
      "single",
      "document_batch",
    ]);
  });

  test("uses local calendar days instead of UTC slices", () => {
    expect(activityDayKey("2026-07-30T12:00:00.000Z")).toBe(
      activityDayKey("2026-07-30T18:00:00.000Z"),
    );
  });
});

describe("review decision folding", () => {
  const reviewer = {
    deletedAt: null,
    id: "user-1",
    image: null,
    name: "Reviewer",
    type: "user",
  } satisfies MatterActivityItem["performer"];

  const decision = (
    id: string,
    { activityAt, runId = null }: { activityAt: string; runId?: string | null },
  ) =>
    item(id, {
      action: "review",
      activityAt,
      performer: reviewer,
      runId,
      target: { id: "run-1", kind: "documentReviewRun" },
    });

  test("collapses a sitting of decisions on one review into one row", () => {
    const groups = groupActivityItems([
      decision("1", { activityAt: "2026-07-30T12:00:00.000Z" }),
      decision("2", { activityAt: "2026-07-30T12:10:00.000Z" }),
      decision("3", { activityAt: "2026-07-30T12:35:00.000Z" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.type).toBe("review_decisions");
    expect(groups[0]?.items).toHaveLength(3);
  });

  test("folds decisions carrying a run id, which belong to their review", () => {
    const groups = groupActivityItems([
      decision("1", { activityAt: "2026-07-30T12:00:00.000Z", runId: "run-a" }),
      decision("2", { activityAt: "2026-07-30T12:01:00.000Z", runId: "run-a" }),
    ]);

    expect(groups.map(({ type }) => type)).toEqual(["review_decisions"]);
  });

  test("starts a new row past the window, on another review, or another actor", () => {
    const later = groupActivityItems([
      decision("1", { activityAt: "2026-07-30T12:00:00.000Z" }),
      decision("2", { activityAt: "2026-07-30T12:31:00.000Z" }),
    ]);
    expect(later).toHaveLength(2);

    const otherRun = groupActivityItems([
      decision("1", { activityAt: "2026-07-30T12:00:00.000Z" }),
      item("2", {
        action: "review",
        activityAt: "2026-07-30T12:01:00.000Z",
        performer: reviewer,
        runId: null,
        target: { id: "run-2", kind: "documentReviewRun" },
      }),
    ]);
    expect(otherRun).toHaveLength(2);

    const otherActor = groupActivityItems([
      decision("1", { activityAt: "2026-07-30T12:00:00.000Z" }),
      item("2", {
        action: "review",
        activityAt: "2026-07-30T12:01:00.000Z",
        performer: { ...reviewer, id: "user-2", name: "Second reviewer" },
        runId: null,
        target: { id: "run-1", kind: "documentReviewRun" },
      }),
    ]);
    expect(otherActor).toHaveLength(2);
  });

  test("leaves the run's own start as its own row", () => {
    const groups = groupActivityItems([
      item("1", {
        action: "execute",
        activityAt: "2026-07-30T12:00:00.000Z",
        performer: reviewer,
        runId: null,
        target: { id: "run-1", kind: "documentReviewRun" },
      }),
      decision("2", { activityAt: "2026-07-30T12:01:00.000Z" }),
    ]);

    expect(groups.map(({ type }) => type)).toEqual([
      "single",
      "review_decisions",
    ]);
  });

  test("keeps folded decisions folded in the list view", () => {
    const groups = expandActivityGroupsForList(
      groupActivityItems([
        decision("1", { activityAt: "2026-07-30T12:00:00.000Z" }),
        decision("2", { activityAt: "2026-07-30T12:01:00.000Z" }),
      ]),
    );

    expect(groups).toHaveLength(1);
  });
});

describe("feed labels", () => {
  // The maps are typed `Record<Kind, TranslationKey>`, so a missing key or a
  // kind without a label fails the build. What is left to check is that no two
  // kinds share a label and that "automation" labels only automation.
  test("every target kind and action carries a label of its own", () => {
    const targetLabels = Object.values(TARGET_LABEL_KEYS);
    expect(new Set(targetLabels).size).toBe(targetLabels.length);
    expect(Object.keys(TARGET_LABEL_KEYS)).toContain("documentReviewRun");
    for (const [kind, key] of Object.entries(TARGET_LABEL_KEYS)) {
      expect(key.startsWith("workspaces.overview.activity.targets.")).toBe(
        true,
      );
      expect(key === "workspaces.overview.activity.targets.automation").toBe(
        kind === "automation",
      );
    }

    const actionLabels = Object.values(ROW_ACTION_LABEL_KEYS);
    expect(new Set(actionLabels).size).toBe(actionLabels.length);
    for (const key of actionLabels) {
      expect(key.startsWith("workspaces.overview.activity.actorActions.")).toBe(
        true,
      );
    }
  });
});
