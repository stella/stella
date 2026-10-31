import type {
  DroppableContainer,
  SensorContext,
  UniqueIdentifier,
} from "@dnd-kit/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import {
  getKanbanKeyboardTargetState,
  kanbanKeyboardCoordinates,
} from "./sortable-interactions.logic";

GlobalRegistrator.register();
afterAll(async () => GlobalRegistrator.unregister());

test("retries the pending virtual row after navigating away from the dragged item", () => {
  const active = {
    data: {
      current: {
        navigation: { current: { targetId: "third", type: "ready" } },
        type: "kanban-item",
      },
    },
    id: "first",
    rect: { current: { initial: null, translated: null } },
  };
  const requests: UniqueIdentifier[] = [];
  const containers = new Map<UniqueIdentifier, DroppableContainer>();
  const droppableContainers = Object.assign(containers, {
    getEnabled: () => [...containers.values()],
    getNodeFor: (id: UniqueIdentifier | null | undefined) =>
      containers.get(id ?? "")?.node.current ?? undefined,
    toArray: () => [...containers.values()],
  });
  const cell = {
    data: {
      current: {
        itemIds: ["first", "second", "third", "fourth"],
        navigation: {
          requestScroll: ({ itemId }: { itemId: UniqueIdentifier }) =>
            requests.push(itemId),
          type: "virtual",
        },
        position: { column: 0, lane: 0 },
        type: "kanban-cell",
      },
    },
    disabled: false,
    id: "cell",
    key: "cell",
    node: { current: document.createElement("div") },
    rect: { current: null },
  };
  containers.set(cell.id, cell);
  for (const id of ["first", "second", "third"]) {
    containers.set(id, {
      data: {
        current: {
          type: "kanban-item",
          navigation: active.data.current.navigation,
          sortable: {
            containerId: "cell",
            index: 0,
            items: cell.data.current.itemIds,
          },
        },
      },
      disabled: false,
      id,
      key: id,
      node: { current: document.createElement("div") },
      rect: { current: null },
    });
  }
  const context = {
    activatorEvent: null,
    active,
    activeNode: null,
    collisionRect: null,
    collisions: [],
    draggableNodes: new Map(),
    draggingNode: null,
    draggingNodeRect: null,
    droppableContainers,
    droppableRects: new Map(),
    over: null,
    scrollableAncestors: [],
    scrollAdjustedTranslate: null,
  } satisfies SensorContext;
  const move = () =>
    kanbanKeyboardCoordinates(
      new KeyboardEvent("keydown", { code: "ArrowDown" }),
      {
        active: active.id,
        context,
        currentCoordinates: { x: 0, y: 0 },
      },
    );

  expect(move()).toBeUndefined();
  expect(requests).toEqual(["fourth"]);
  expect(getKanbanKeyboardTargetState(active.data.current)).toEqual({
    type: "pending",
    targetId: "fourth",
  });

  // Pending collision detection publishes no over target while the row mounts.
  expect(context.over).toBeNull();
  expect(move()).toBeUndefined();
  expect(requests).toEqual(["fourth", "fourth"]);

  const fourth = document.createElement("div");
  containers.set("fourth", {
    ...cell,
    id: "fourth",
    key: "fourth",
    node: { current: fourth },
  });
  context.droppableRects.set("fourth", {
    top: 400,
    left: 20,
    right: 120,
    bottom: 496,
    width: 100,
    height: 96,
  });
  expect(move()).toEqual({ x: 20, y: 400 });
  expect(getKanbanKeyboardTargetState(active.data.current)).toEqual({
    type: "ready",
    targetId: "fourth",
  });
});
