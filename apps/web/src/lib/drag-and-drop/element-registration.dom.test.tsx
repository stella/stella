import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";

GlobalRegistrator.register();
afterAll(async () => await GlobalRegistrator.unregister());
const { attachElementDropTarget } =
  await import("@/components/workspaces/kanban/use-kanban-drop-targets");
const { draggable, dropTargetForElements } =
  await import("./element-registration");

const registrations = { draggable, dropTargetForElements };

for (const [kind, register] of Object.entries(registrations)) {
  describe(`${kind} element ownership`, () => {
    test("one live registration keeps its cleanup", () => {
      const element = document.createElement("div");
      const cleanup = register({ element, name: "first" });
      expect(typeof cleanup).toBe("function");
      expect(() => register({ element, name: "second" })).toThrow(
        /first.*second/u,
      );
      cleanup();
    });

    test("cleanup admits the next registration and can run twice", () => {
      const element = document.createElement("div");
      const first = register({ element });
      first();
      const second = register({ element });
      first();
      expect(() => register({ element })).toThrow(/conflict/u);
      second();
      const third = register({ element });
      third();
    });

    test("different elements carry independent registrations", () => {
      const first = register({ element: document.createElement("div") });
      const second = register({ element: document.createElement("div") });
      first();
      second();
    });
  });
}

test("a draggable and a drop target share one element", () => {
  const element = document.createElement("div");
  const source = draggable({ element });
  const target = dropTargetForElements({ element });
  expect(() => draggable({ element })).toThrow(/draggable conflict/u);
  expect(() => dropTargetForElements({ element })).toThrow(
    /drop target conflict/u,
  );
  source();
  const nextSource = draggable({ element });
  expect(() => dropTargetForElements({ element })).toThrow(
    /drop target conflict/u,
  );
  target();
  const nextTarget = dropTargetForElements({ element });
  nextSource();
  nextTarget();
});

test("kanban and other surfaces share drop target ownership", () => {
  const element = document.createElement("div");
  const cleanup = attachElementDropTarget({ element, name: "kanban" });
  expect(() =>
    dropTargetForElements({ element, name: "other surface" }),
  ).toThrow(/kanban.*other surface/u);
  cleanup();
  const next = dropTargetForElements({ element, name: "other surface" });
  next();
});
