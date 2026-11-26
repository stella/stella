import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { KANBAN_CARD_STICKY_TOP_VAR } from "./sticky-lane";
import { KanbanVirtualCell } from "./virtual-cell";
import type { KanbanVirtualCellProps } from "./virtual-cell";

GlobalRegistrator.register({ url: "https://example.test" });
const { cleanup, render } = await import("@testing-library/react");

const FOOTER_HEIGHT = 40;
const BOX_HEIGHT = 400;
const originalRect = HTMLElement.prototype.getBoundingClientRect;
// Static boxes: the pinned action is 40px tall, and everything else is tall
// enough for the virtualizer to render the row.
HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(
  this: HTMLElement,
) {
  const height = Object.hasOwn(this.dataset, "kanbanCellFooter")
    ? FOOTER_HEIGHT
    : BOX_HEIGHT;
  return DOMRect.fromRect({ height, width: 200, x: 0, y: 0 });
};
// The virtualizer sizes its window from the scroll element's client box.
const clientBox = {
  clientHeight: Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  ),
  clientWidth: Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  ),
};
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => BOX_HEIGHT,
});
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get: () => 200,
});

afterEach(() => cleanup());
afterAll(async () => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  for (const [name, descriptor] of Object.entries(clientBox)) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    } else {
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
  }
  await unregisterDomEnvironment();
});

const cell = (overrides: Partial<KanbanVirtualCellProps<string>>) => (
  <KanbanVirtualCell
    footer={<button type="button">Add</button>}
    getRowKey={(row) => row}
    pagination={{ type: "none" }}
    renderRow={(row) => <span>{row}</span>}
    rows={["one"]}
    {...overrides}
  />
);

const pinnedAbove = (container: HTMLElement) => {
  const row = container.querySelector<HTMLElement>('[data-index="0"]');
  if (row === null) {
    throw new Error("no row rendered");
  }
  return row.style.getPropertyValue(KANBAN_CARD_STICKY_TOP_VAR);
};

describe("KanbanVirtualCell pinned action height", () => {
  test("rows rest under the pinned action from the first paint", () => {
    const view = render(cell({ footerPlacement: "sticky-start" }));

    expect(pinnedAbove(view.container)).toContain(`+ ${FOOTER_HEIGHT}px`);
  });

  test("the reach drops to zero once the action closes the cell instead", () => {
    const view = render(cell({ footerPlacement: "sticky-start" }));
    view.rerender(cell({ footerPlacement: "end" }));

    expect(pinnedAbove(view.container)).toContain("+ 0px");
  });
});
