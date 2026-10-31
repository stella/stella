import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { DOCUMENT_PANEL_BOTTOM_INSET } from "@stll/ui/panel-inset";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const {
  SELECTION_TOOLBAR_EDGE_MARGIN_PX,
  SELECTION_TOOLBAR_OFFSET_PX,
  scrollMovesSelection,
  selectionToolbarBounds,
  selectionToolbarPosition,
} = await import("@/components/selection-toolbar.logic");

afterAll(async () => {
  await unregisterDomEnvironment();
});

const mountReader = (inset: string | null) => {
  const host = document.createElement("div");
  const scroller = document.createElement("div");
  const root = document.createElement("div");
  host.append(scroller);
  scroller.append(root);
  document.body.append(host);
  for (const node of [document.documentElement, document.body, host, root]) {
    node.style.overflowX = "visible";
    node.style.overflowY = "visible";
  }
  scroller.style.overflowX = "auto";
  scroller.style.overflowY = "auto";
  host.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700);
  scroller.getBoundingClientRect = () => new DOMRect(0, 40, 900, 660);
  root.getBoundingClientRect = () => new DOMRect(0, 40, 900, 2000);
  if (inset !== null) {
    host.style.setProperty(DOCUMENT_PANEL_BOTTOM_INSET, inset);
  }
  return { host, root };
};

test("the docked composer's covered strip is outside the selection bar's room", () => {
  const { host, root } = mountReader("120px");
  try {
    const bounds = selectionToolbarBounds(root);
    expect(bounds?.top).toBe(40);
    expect(bounds?.bottom).toBe(700 - 120);
    if (bounds === null) {
      throw new Error("expected bounds");
    }

    // A selection just above the composer opens its actions above the line
    // instead of on top of the chat bar.
    const position = selectionToolbarPosition({
      anchor: { left: 400, right: 400, top: 540, bottom: 560 },
      barWidth: 300,
      barHeight: 36,
      bounds,
    });
    expect(position.top).toBe(540 - SELECTION_TOOLBAR_OFFSET_PX - 36);
    expect(position.top + 36).toBeLessThanOrEqual(
      bounds.bottom - SELECTION_TOOLBAR_EDGE_MARGIN_PX,
    );
  } finally {
    host.remove();
  }
});

test("a reader without docked chrome keeps its whole scroll area", () => {
  const { host, root } = mountReader(null);
  try {
    expect(selectionToolbarBounds(root)?.bottom).toBe(700);
  } finally {
    host.remove();
  }
});

test("only a scroll outside the bar's own surfaces moves the selection", () => {
  const { host, root } = mountReader(null);
  const menu = document.createElement("div");
  const preview = document.createElement("div");
  menu.append(preview);
  document.body.append(menu);
  const scrollOf = (target: EventTarget): Event => {
    const event = new Event("scroll");
    target.dispatchEvent(event);
    return event;
  };
  try {
    expect(scrollMovesSelection(scrollOf(preview), [null, menu])).toBe(false);
    expect(scrollMovesSelection(scrollOf(menu), [null, menu])).toBe(false);
    expect(scrollMovesSelection(scrollOf(root), [null, menu])).toBe(true);
    expect(scrollMovesSelection(scrollOf(document), [null, menu])).toBe(true);
    expect(scrollMovesSelection(scrollOf(preview), [null, null])).toBe(true);
  } finally {
    menu.remove();
    host.remove();
  }
});
