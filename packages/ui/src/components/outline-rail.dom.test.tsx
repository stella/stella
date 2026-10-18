import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { OutlineRail, type OutlineItem } from "./outline-rail";

const items = [
  { id: "introduction", label: "Introduction", level: 1 },
  { id: "analysis", label: "Analysis", level: 1 },
] satisfies OutlineItem[];

let previousActEnvironment: unknown;

beforeAll(() => {
  GlobalRegistrator.register();
  previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterAll(async () => {
  if (previousActEnvironment === undefined) {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  } else {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  }
  await GlobalRegistrator.unregister();
});

const renderOutline = async (presentation: "popover" | "rail" = "popover") => {
  const container = document.createElement("div");
  const scrollContainer = document.createElement("div");
  document.body.append(container, scrollContainer);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <OutlineRail
        ariaLabel="Document outline"
        items={items}
        onJump={() => undefined}
        presentation={presentation}
        resolvePct={(id) => (id === "introduction" ? 10 : 80)}
        scrollContainerRef={{ current: scrollContainer }}
      />,
    );
  });
  return { container, root, scrollContainer };
};

const cleanup = async (
  root: Root,
  container: HTMLElement,
  scrollContainer: HTMLElement,
) => {
  await act(async () => root.unmount());
  container.remove();
  scrollContainer.remove();
};

test("popover renders no outline toggle button", async () => {
  const rendered = await renderOutline();
  try {
    expect(
      rendered.container.querySelector('button[aria-label="Document outline"]'),
    ).toBeNull();
  } finally {
    await cleanup(rendered.root, rendered.container, rendered.scrollContainer);
  }
});

test("focusing a tick opens the popover", async () => {
  const rendered = await renderOutline();
  try {
    const ticks = rendered.container.querySelector<HTMLElement>(
      "[data-outline-ticks]",
    );
    const tick = ticks?.querySelector<HTMLButtonElement>("button");
    expect(ticks).not.toBeNull();
    expect(tick).not.toBeNull();
    await act(async () => tick?.focus());
    expect(ticks?.getAttribute("aria-expanded")).toBe("true");
  } finally {
    await cleanup(rendered.root, rendered.container, rendered.scrollContainer);
  }
});

test("Escape closes the popover and restores focus to its tick", async () => {
  const rendered = await renderOutline();
  try {
    const ticks = rendered.container.querySelector<HTMLElement>(
      "[data-outline-ticks]",
    );
    const tick = ticks?.querySelector<HTMLButtonElement>("button");
    const panel = rendered.container.querySelector<HTMLElement>("nav");
    const panelButton = panel?.querySelector<HTMLButtonElement>("button");
    await act(async () => tick?.focus());
    await act(async () => panelButton?.focus());
    await act(async () => {
      panelButton?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
    });
    expect(ticks?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(tick ?? null);
  } finally {
    await cleanup(rendered.root, rendered.container, rendered.scrollContainer);
  }
});

test("moving focus outside the rail closes the popover", async () => {
  const rendered = await renderOutline();
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    const ticks = rendered.container.querySelector<HTMLElement>(
      "[data-outline-ticks]",
    );
    const tick = ticks?.querySelector<HTMLButtonElement>("button");
    await act(async () => tick?.focus());
    await act(async () => outside.focus());
    expect(ticks?.getAttribute("aria-expanded")).toBe("false");
  } finally {
    outside.remove();
    await cleanup(rendered.root, rendered.container, rendered.scrollContainer);
  }
});

test("rail presentation remains a host-owned tick strip", async () => {
  const rendered = await renderOutline("rail");
  try {
    const group = rendered.container.querySelector('[role="group"]');
    const ticks = rendered.container.querySelector("[data-outline-ticks]");
    expect(group?.getAttribute("aria-label")).toBe("Document outline");
    expect(ticks).not.toBeNull();
    expect(ticks?.hasAttribute("aria-controls")).toBe(false);
    expect(rendered.container.querySelector("nav")).toBeNull();
  } finally {
    await cleanup(rendered.root, rendered.container, rendered.scrollContainer);
  }
});
