import { describe, expect, test } from "bun:test";

import {
  getDragAnnouncementMessageKey,
  getDragAnnouncementSubject,
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

    expect(getDragAnnouncementSubject(data)).toEqual({
      count: 1,
      name: "Case timeline",
    });
  });

  test("preserves the item count for plural agreement", () => {
    const data = withDragAnnouncementData({}, "3 selected items", 3);

    expect(getDragAnnouncementSubject(data)).toEqual({
      count: 3,
      name: "3 selected items",
    });
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

  test("ignores malformed data owned by another drag source", () => {
    const malformed = {
      "stella/drag-announcement": { type: "item", name: 42 },
    };

    expect(getDragAnnouncementSubject(malformed)).toBeNull();
    expect(getDropAnnouncementDestination([{ data: malformed }])).toBeNull();
  });
});
