import { isValidElement, type ReactNode } from "react";

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { OVERLAY_COLLISION_PADDING } from "../lib/overlay-layer";
import { PopoverPopup } from "./popover";
import { TooltipPopup } from "./tooltip";

type SlotProps = {
  children?: ReactNode;
  className?: string;
  collisionPadding?: number;
  "data-slot"?: string;
};

// The positioner mounts through a portal, which renders nothing on the server,
// so `renderToStaticMarkup` cannot reach it. Walk the single-child chain the
// popup builds instead (portal, positioner, popup, viewport): `cn` has already
// run by then, so these are the props the browser would receive.
const findSlot = (root: ReactNode, slot: string): SlotProps => {
  let node = root;
  while (isValidElement<SlotProps>(node)) {
    if (node.props["data-slot"] === slot) {
      return node.props;
    }
    node = node.props.children;
  }
  return panic(`No element with data-slot="${slot}" in the popup tree`);
};

describe("PopoverPopup", () => {
  test("sizes the positioner to the rendered popup, not to the payload width", () => {
    const positioner = findSlot(
      PopoverPopup({ children: "content" }),
      "popover-positioner",
    );

    // `w-(--positioner-width)` pins the positioner to the width measured when
    // the payload last changed. Content that grows from local state then
    // renders wider than the box Base UI collision-tests, so `shift()` sees no
    // overflow and the popup runs off-screen.
    expect(positioner.className).not.toContain("w-(--positioner-width)");
    expect(positioner.className).toContain("w-max");
    expect(positioner.className).toContain("max-w-(--available-width)");
    expect(positioner.collisionPadding).toBe(OVERLAY_COLLISION_PADDING);
  });
});

describe("TooltipPopup", () => {
  test("sizes its positioner the same way the popover does", () => {
    const positioner = findSlot(
      TooltipPopup({ children: "content" }),
      "tooltip-positioner",
    );

    expect(positioner.className).not.toContain("w-(--positioner-width)");
    expect(positioner.className).toContain("w-max");
    expect(positioner.className).toContain("max-w-(--available-width)");
    expect(positioner.collisionPadding).toBe(OVERLAY_COLLISION_PADDING);
  });
});
