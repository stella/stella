import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity } from "@/lib/types";
import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  buildTree,
  countDescendants,
  findNode,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const entity = (
  entityId: string,
  parentId: string | null = null,
): WorkspaceEntity => ({
  entityId: toSafeId<"entity">(entityId),
  kind: "folder",
  name: entityId,
  parentId: parentId ? toSafeId<"entity">(parentId) : null,
  createdAt: "2025-01-01T00:00:00.000Z",
  createdBy: null,
  createdByImage: null,
  createdByDeletedAt: null,
  updatedAt: null,
  version: 1,
  status: null,
  priority: null,
  dueDate: null,
  agendaKind: "task",
  startAt: null,
  endAt: null,
  occurredAt: null,
  remindAt: null,
  allDay: false,
  timeZone: null,
  location: null,
  onlineMeetingUrl: null,
  availability: null,
  sensitivity: null,
  organizer: null,
  attendees: null,
  recurrence: null,
  agendaSource: "manual",
  externalSource: null,
  externalId: null,
  externalChangeKey: null,
  externalICalUid: null,
  readOnly: false,
  sortOrder: null,
  activeEditBy: null,
  cellMetadata: {},
  fields: {},
});

const ids = (nodes: readonly { entityId: string }[]) =>
  nodes.map((n) => n.entityId).toSorted();

const treeNode = (id: string): TableTreeNode => ({
  ...entity(id),
  children: [],
});

describe("buildTree", () => {
  test("nests entities under their parent, preserving order", () => {
    const tree = buildTree([
      entity("root"),
      entity("child-a", "root"),
      entity("child-b", "root"),
      entity("grandchild", "child-a"),
    ]);

    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect(root?.entityId).toBe(toSafeId<"entity">("root"));
    expect(ids(root?.children ?? [])).toEqual(
      ids([{ entityId: "child-a" }, { entityId: "child-b" }]),
    );
    const childA = root?.children.find(
      (c) => c.entityId === toSafeId<"entity">("child-a"),
    );
    expect(childA?.children.map((c) => c.entityId)).toEqual([
      toSafeId<"entity">("grandchild"),
    ]);
  });

  test("treats an entity whose parent is not in the list as a root", () => {
    const tree = buildTree([entity("orphan", "missing-parent")]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.entityId).toBe(toSafeId<"entity">("orphan"));
    expect(tree[0]?.children).toEqual([]);
  });

  test("breaks a self-parent cycle by treating the node as a root", () => {
    const tree = buildTree([entity("self", "self")]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.entityId).toBe(toSafeId<"entity">("self"));
    expect(tree[0]?.children).toEqual([]);
  });

  test("breaks a two-node cycle by treating both nodes as roots", () => {
    const tree = buildTree([entity("a", "b"), entity("b", "a")]);

    expect(ids(tree)).toEqual(ids([{ entityId: "a" }, { entityId: "b" }]));
    for (const node of tree) {
      expect(node.children).toEqual([]);
    }
  });

  test("keeps a valid subtree intact next to an unrelated cycle, and still attaches a non-cyclic tail hanging off a cyclic node", () => {
    const tree = buildTree([
      entity("root"),
      entity("branch", "root"),
      entity("leaf", "branch"),
      // Self-contained cycle, unrelated to the valid subtree above.
      entity("cycle-a", "cycle-b"),
      entity("cycle-b", "cycle-a"),
      // Not itself cyclic, but its declared parent is a cyclic node.
      entity("tail", "cycle-a"),
    ]);

    expect(ids(tree)).toEqual(
      ids([
        { entityId: "root" },
        { entityId: "cycle-a" },
        { entityId: "cycle-b" },
      ]),
    );

    const root = tree.find((n) => n.entityId === toSafeId<"entity">("root"));
    expect(root?.children.map((c) => c.entityId)).toEqual([
      toSafeId<"entity">("branch"),
    ]);
    expect(root?.children[0]?.children.map((c) => c.entityId)).toEqual([
      toSafeId<"entity">("leaf"),
    ]);

    const cycleA = tree.find(
      (n) => n.entityId === toSafeId<"entity">("cycle-a"),
    );
    expect(cycleA?.children.map((c) => c.entityId)).toEqual([
      toSafeId<"entity">("tail"),
    ]);

    const cycleB = tree.find(
      (n) => n.entityId === toSafeId<"entity">("cycle-b"),
    );
    expect(cycleB?.children).toEqual([]);
  });
});

describe("findNode / countDescendants cycle safety", () => {
  test("findNode terminates and returns null when the target is absent from a cyclic tree", () => {
    const a = treeNode("a");
    const b = treeNode("b");
    a.children.push(b);
    b.children.push(a);

    expect(findNode([a], "does-not-exist")).toBeNull();
  });

  test("findNode still finds a present target inside a cyclic tree", () => {
    const a = treeNode("a");
    const b = treeNode("b");
    a.children.push(b);
    b.children.push(a);

    const found = findNode([a], toSafeId<"entity">("b"));
    expect(found?.entityId).toBe(toSafeId<"entity">("b"));
  });

  test("countDescendants terminates and counts each cyclic node once", () => {
    const a = treeNode("a");
    const b = treeNode("b");
    const c = treeNode("c");
    a.children.push(b);
    b.children.push(c);
    c.children.push(a);

    expect(countDescendants(a)).toBe(2);
  });
});
