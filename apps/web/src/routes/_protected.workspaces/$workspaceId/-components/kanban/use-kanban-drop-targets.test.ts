import { describe, expect, mock, test } from "bun:test";

// The real `dropTargetForElements`/`draggable` reach into DOM APIs
// (addEventListener, dataset, ...) that this bun:test process has no DOM
// for. These tests only exercise the conflict registry in
// `attachElementDropTarget`, so those two are replaced with a no-op
// stand-in before importing the module under test. Every other export
// (notably `monitorForElements`, which `@stll/ui/kanban`'s auto-scroll
// wiring calls as a module-load side effect) is passed through untouched
// so unrelated kanban tests sharing this bun:test process are unaffected.
const realAdapter =
  await import("@atlaskit/pragmatic-drag-and-drop/element/adapter");
void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  ...realAdapter,
  dropTargetForElements: () => () => undefined,
  draggable: () => () => undefined,
}));

const { attachElementDropTarget } = await import("./use-kanban-drop-targets");

// SAFETY: attachElementDropTarget only ever uses `element` as a WeakMap key
// in these tests; the adapter above is mocked to a no-op, so no DOM API on
// this stand-in element is ever invoked.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for a DOM Element; see the SAFETY note above.
const stubElement = (): Element => ({}) as unknown as Element;

describe("attachElementDropTarget", () => {
  test("throws when a second target registers on the same element", () => {
    const element = stubElement();
    const cleanupCard = attachElementDropTarget({ element, name: "card" });

    expect(() =>
      attachElementDropTarget({ element, name: "column-reorder" }),
    ).toThrow(/card/u);
    expect(() =>
      attachElementDropTarget({ element, name: "column-reorder" }),
    ).toThrow(/column-reorder/u);

    cleanupCard();
  });

  test("allows the same element to register again once the prior target cleans up", () => {
    const element = stubElement();
    const cleanupCard = attachElementDropTarget({ element, name: "card" });
    cleanupCard();

    expect(() => {
      const cleanupReorder = attachElementDropTarget({
        element,
        name: "column-reorder",
      });
      cleanupReorder();
    }).not.toThrow();
  });

  test("allows distinct targets on a parent and its child element", () => {
    const parent = stubElement();
    const child = stubElement();

    expect(() => {
      const cleanupParent = attachElementDropTarget({
        element: parent,
        name: "column-reorder",
      });
      const cleanupChild = attachElementDropTarget({
        element: child,
        name: "card",
      });
      cleanupChild();
      cleanupParent();
    }).not.toThrow();
  });
});
