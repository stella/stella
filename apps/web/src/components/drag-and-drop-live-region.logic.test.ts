import { describe, expect, test } from "bun:test";

import {
  formatDragCancellationAnnouncement,
  formatDragDestinationAnnouncement,
  formatDragPickupAnnouncement,
  formatSelectedItemsAnnouncement,
  getDragAnnouncementMessageKey,
  getDragAnnouncementName,
  getDropAnnouncementDestination,
  withDragAnnouncementData,
  withDropAnnouncementData,
} from "./drag-and-drop-live-region.logic";

describe("drag-and-drop announcement data", () => {
  test("reads the item name from production-shaped drag data", () => {
    const data = withDragAnnouncementData(
      { type: "stella/view-id", viewId: "view-123" },
      "Case timeline",
    );

    expect(getDragAnnouncementName(data)).toBe("Case timeline");
  });

  test("uses the nearest accessible drop target", () => {
    const destination = getDropAnnouncementDestination([
      {
        data: withDropAnnouncementData(
          { viewId: "view-456" },
          { type: "reorder", name: "Documents" },
        ),
      },
      {
        data: withDropAnnouncementData(
          {},
          { type: "container", name: "Matter" },
        ),
      },
    ]);

    expect(destination).toEqual({ type: "reorder", name: "Documents" });
  });

  test("preserves a drop that opens a follow-up action", () => {
    const destination = getDropAnnouncementDestination([
      {
        data: withDropAnnouncementData(
          {},
          { type: "action", name: "Contract review" },
        ),
      },
    ]);

    expect(destination).toEqual({ type: "action", name: "Contract review" });
  });

  test("maps every destination kind to truthful progress and result copy", () => {
    expect([
      getDragAnnouncementMessageKey("moving", "action"),
      getDragAnnouncementMessageKey("moved", "action"),
      getDragAnnouncementMessageKey("moving", "container"),
      getDragAnnouncementMessageKey("moved", "container"),
      getDragAnnouncementMessageKey("moving", "reorder"),
      getDragAnnouncementMessageKey("moved", "reorder"),
    ]).toEqual([
      "movingTo",
      "droppedOn",
      "movingTo",
      "movedTo",
      "movingNear",
      "movedNear",
    ]);
  });

  test("formats the centralized English live-region copy", () => {
    expect(formatDragPickupAnnouncement("Contract.pdf")).toBe(
      "Picked up Contract.pdf.",
    );
    expect(formatDragCancellationAnnouncement("Contract.pdf")).toBe(
      "Move cancelled. Contract.pdf was not moved.",
    );
    expect(formatSelectedItemsAnnouncement(3)).toBe("3 selected items");
  });

  test.each([
    {
      destination: { name: "Contract review", type: "action" },
      expected: "Moving Contract.pdf to Contract review.",
      phase: "moving",
    },
    {
      destination: { name: "Contract review", type: "action" },
      expected: "Dropped Contract.pdf on Contract review.",
      phase: "moved",
    },
    {
      destination: { name: "Finance", type: "container" },
      expected: "Moved Contract.pdf to Finance.",
      phase: "moved",
    },
    {
      destination: { name: "Documents", type: "reorder" },
      expected: "Moving Contract.pdf near Documents.",
      phase: "moving",
    },
    {
      destination: { name: "Documents", type: "reorder" },
      expected: "Moved Contract.pdf near Documents.",
      phase: "moved",
    },
  ] as const)(
    "formats the $phase $destination.type destination announcement",
    ({ destination, expected, phase }) => {
      expect(
        formatDragDestinationAnnouncement({
          destination,
          itemName: "Contract.pdf",
          phase,
        }),
      ).toBe(expected);
    },
  );

  test("ignores malformed data owned by another drag source", () => {
    const malformed = {
      "stella/drag-announcement": { type: "item", name: 42 },
    };

    expect(getDragAnnouncementName(malformed)).toBeNull();
    expect(getDropAnnouncementDestination([{ data: malformed }])).toBeNull();
  });
});
