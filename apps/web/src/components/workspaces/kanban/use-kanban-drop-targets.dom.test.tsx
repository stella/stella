import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register();
afterAll(async () => await unregisterDomEnvironment());
const { attachElementDropTarget } = await import("./use-kanban-drop-targets");

const stubElement = (): Element => document.createElement("div");

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
