import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, jest, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { restoreRealTimers } from "@stll/property-testing/fake-timers";

import { type OutlineItem, OutlineRail } from "./outline-rail";

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
  await unregisterDomEnvironment();
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

// React derives mouseenter from a mouseover whose related target is outside.
const hover = async (target: HTMLElement | null | undefined) => {
  await act(async () => {
    target?.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        relatedTarget: document.body,
      }),
    );
  });
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
    expect(ticks?.hasAttribute("aria-controls")).toBe(false);
    expect(tick?.getAttribute("aria-controls")).toBe(
      rendered.container.querySelector("nav")?.id,
    );
    await act(async () => tick?.focus());
    expect(tick?.getAttribute("aria-expanded")).toBe("true");
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
    expect(tick?.getAttribute("aria-expanded")).toBe("false");
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
    expect(tick?.getAttribute("aria-expanded")).toBe("false");
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
    expect(ticks?.querySelector("button")?.hasAttribute("aria-controls")).toBe(
      false,
    );
    expect(rendered.container.querySelector("nav")).toBeNull();
  } finally {
    await cleanup(rendered.root, rendered.container, rendered.scrollContainer);
  }
});

test("leaving the rail from inside the panel closes the popover", async () => {
  const rendered = await renderOutline();
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    const ticks = rendered.container.querySelector<HTMLElement>(
      "[data-outline-ticks]",
    );
    const tick = ticks?.querySelector<HTMLButtonElement>("button");
    const panelButton = rendered.container
      .querySelector<HTMLElement>("nav")
      ?.querySelector<HTMLButtonElement>("button");
    await act(async () => tick?.focus());
    await act(async () => panelButton?.focus());
    expect(tick?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => outside.focus());
    expect(tick?.getAttribute("aria-expanded")).toBe("false");
  } finally {
    outside.remove();
    await cleanup(rendered.root, rendered.container, rendered.scrollContainer);
  }
});

test("the tick strip opens the panel only when the pointer rests on it", async () => {
  const rendered = await renderOutline();
  const outside = document.createElement("div");
  document.body.append(outside);
  jest.useFakeTimers();
  try {
    const strip = rendered.container.querySelector<HTMLElement>(
      "[data-outline-ticks]",
    );
    const tick = strip?.querySelector<HTMLButtonElement>("button");
    const leave = () =>
      strip?.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: outside }),
      );

    // Crossing the strip on the way elsewhere opens nothing, then or later.
    await hover(strip);
    await act(async () => {
      jest.advanceTimersByTime(60);
      leave();
      jest.advanceTimersByTime(500);
    });
    expect(tick?.getAttribute("aria-expanded")).toBe("false");

    // Resting on it does.
    await hover(strip);
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(tick?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(tick?.getAttribute("aria-expanded")).toBe("true");
  } finally {
    restoreRealTimers();
    outside.remove();
    await cleanup(rendered.root, rendered.container, rendered.scrollContainer);
  }
});

test("focus inside a hover-opened panel holds it open after the pointer leaves", async () => {
  const rendered = await renderOutline();
  const outside = document.createElement("div");
  document.body.append(outside);
  try {
    const tick = rendered.container.querySelector<HTMLButtonElement>(
      "[data-outline-ticks] button",
    );
    const panel = rendered.container.querySelector<HTMLElement>("nav");
    const panelButton = panel?.querySelector<HTMLButtonElement>("button");
    await hover(panel);
    await act(async () => panelButton?.focus());
    expect(document.activeElement).toBe(panelButton ?? null);
    jest.useFakeTimers();
    try {
      await act(async () => {
        panel?.dispatchEvent(
          new MouseEvent("mouseout", { bubbles: true, relatedTarget: outside }),
        );
        // Past the hover close delay.
        jest.advanceTimersByTime(200);
      });
    } finally {
      restoreRealTimers();
    }
    expect(tick?.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.hasAttribute("inert")).toBe(false);
  } finally {
    outside.remove();
    await cleanup(rendered.root, rendered.container, rendered.scrollContainer);
  }
});

test("Escape from a panel opened without a focused tick lands on a tick", async () => {
  const rendered = await renderOutline();
  try {
    const ticks = rendered.container.querySelectorAll<HTMLButtonElement>(
      "[data-outline-ticks] button",
    );
    const panel = rendered.container.querySelector<HTMLElement>("nav");
    const panelButton = panel?.querySelector<HTMLButtonElement>("button");
    await hover(panel);
    await act(async () => panelButton?.focus());
    expect(document.activeElement).toBe(panelButton ?? null);
    await act(async () => {
      panelButton?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
    });
    expect([...ticks].some((tick) => tick === document.activeElement)).toBe(
      true,
    );
    expect(ticks[0]?.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await cleanup(rendered.root, rendered.container, rendered.scrollContainer);
  }
});

test("a branch the reader closed stays closed when the items are rebuilt", async () => {
  const nested = [
    { id: "terms", label: "Terms", level: 0, meta: "1" },
    { id: "waiver", label: "Waiver", level: 1, meta: "2" },
    { id: "notices", label: "Notices", level: 0, meta: "3" },
  ] satisfies OutlineItem[];
  const container = document.createElement("div");
  const scrollContainer = document.createElement("div");
  document.body.append(container, scrollContainer);
  const root = createRoot(container);
  const renderItems = async (next: OutlineItem[]) =>
    await act(async () => {
      root.render(
        <OutlineRail
          items={next}
          onJump={() => undefined}
          presentation="panel"
          resolvePct={() => 50}
          scrollContainerRef={{ current: scrollContainer }}
        />,
      );
    });
  try {
    await renderItems(nested);
    const collapse = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse"]',
    );
    await act(async () => collapse?.click());
    expect(container.textContent).not.toContain("Waiver");

    // A relayout moves a later heading to another page.
    await renderItems(
      nested.map((item) =>
        item.id === "notices" ? { ...item, meta: "4" } : { ...item },
      ),
    );

    expect(container.textContent).not.toContain("Waiver");
    expect(container.textContent).toContain("4");
  } finally {
    await cleanup(root, container, scrollContainer);
  }
});

const renderItems = async (railItems: OutlineItem[]) => {
  const container = document.createElement("div");
  const scrollContainer = document.createElement("div");
  document.body.append(container, scrollContainer);
  const root = createRoot(container);
  const render = async (next: OutlineItem[]) => {
    await act(async () => {
      root.render(
        <OutlineRail
          ariaLabel="Document outline"
          items={next}
          onJump={() => undefined}
          resolvePct={(id) => (id === "opinion" ? 90 : 10)}
          scrollContainerRef={{ current: scrollContainer }}
        />,
      );
    });
  };
  await render(railItems);
  return { container, render, root, scrollContainer };
};

const OPINION = {
  id: "opinion",
  label: "Svatoň Jan",
  level: 0,
  portraits: [{ image: null, name: "Svatoň Jan" }],
  title: "Dissenting opinion",
} satisfies OutlineItem;

const opinionTick = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(
    '[data-outline-ticks] button[aria-label="Svatoň Jan Dissenting opinion"]',
  );

test("a lone entry with people keeps the rail a lone tick would not", async () => {
  const lone = await renderItems([OPINION]);
  const tick = await renderItems([{ id: "only", label: "Only", level: 0 }]);
  try {
    expect(opinionTick(lone.container)).not.toBeNull();
    expect(tick.container.querySelector("[data-outline-ticks]")).toBeNull();
  } finally {
    await cleanup(lone.root, lone.container, lone.scrollContainer);
    await cleanup(tick.root, tick.container, tick.scrollContainer);
  }
});

test("a tick with people draws no face until it is asked", async () => {
  const { container, root, scrollContainer } = await renderItems([OPINION]);
  try {
    const tick = opinionTick(container);
    expect(tick?.textContent).toBe("");
    expect(tick?.style.height).toBe("2px");
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
  } finally {
    await cleanup(root, container, scrollContainer);
  }
});

test("a lone tick answers with its card, not a list of one", async () => {
  const { container, root, scrollContainer } = await renderItems([OPINION]);
  try {
    expect(container.querySelector("nav")).toBeNull();
    expect(opinionTick(container)?.getAttribute("aria-controls")).toBeNull();
  } finally {
    await cleanup(root, container, scrollContainer);
  }
});

test("resting on a tick names everyone in its card, past what a row fits", async () => {
  const bench = ["Svatoň Jan", "Novák Petr", "Dvořák Eva", "Malý Jiří"];
  const { container, root, scrollContainer } = await renderItems([
    {
      ...OPINION,
      portraitCredit: "Portrait source: Court",
      portraits: bench.map((name) => ({ image: null, name })),
    },
  ]);
  jest.useFakeTimers();
  try {
    const tick = opinionTick(container);
    await act(async () => {
      tick?.dispatchEvent(
        new PointerEvent("pointerover", {
          bubbles: true,
          pointerType: "mouse",
        }),
      );
      tick?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      tick?.dispatchEvent(new MouseEvent("mouseenter"));
      tick?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      jest.advanceTimersByTime(1000);
    });
    const card = document.querySelector('[data-slot="tooltip-popup"]');
    for (const name of bench) {
      expect(card?.textContent).toContain(name);
    }
    expect(card?.textContent).toContain(OPINION.title);
    expect(card?.textContent).toContain("Portrait source: Court");
  } finally {
    restoreRealTimers();
    await cleanup(root, container, scrollContainer);
  }
});

test("an entry with people stays on a rail too dense for its level", async () => {
  const dense = Array.from({ length: 60 }, (_, index) => ({
    id: `shallow-${index}`,
    label: `Shallow ${index}`,
    level: index % 2,
  })) satisfies OutlineItem[];
  const { container, root, scrollContainer } = await renderItems([
    ...dense,
    { ...OPINION, level: 1 },
  ]);
  try {
    expect(
      container.querySelector('button[aria-label="Shallow 1"]'),
    ).toBeNull();
    expect(opinionTick(container)).not.toBeNull();
  } finally {
    await cleanup(root, container, scrollContainer);
  }
});

test("a changed person reaches the panel when the items are rebuilt", async () => {
  const other = { id: "other", label: "Other", level: 0 };
  const { container, render, root, scrollContainer } = await renderItems([
    OPINION,
    other,
  ]);
  try {
    await render([
      { ...OPINION, portraits: [{ image: null, name: "Novák Petr" }] },
      other,
    ]);
    expect(container.querySelector("nav")?.textContent).toContain("NP");
  } finally {
    await cleanup(root, container, scrollContainer);
  }
});
