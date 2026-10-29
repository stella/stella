import { describe, expect, test } from "bun:test";

import {
  AVAILABLE_EVERYWHERE,
  filterAvailable,
  isAvailable,
  REQUIREMENT,
  type Requirement,
} from "@/lib/platform/requirements.logic";

const ALL_REQUIREMENTS = Object.values(REQUIREMENT);

// Every subset of the requirements a device can meet.
let subsets: Requirement[][] = [[]];
for (const requirement of ALL_REQUIREMENTS) {
  subsets = subsets.flatMap((subset) => [subset, subset.concat(requirement)]);
}
const ALL_CAPABILITY_SETS: ReadonlySet<Requirement>[] = subsets.map(
  (subset) => new Set(subset),
);

describe("control availability", () => {
  test("a control available everywhere is offered on every device and layout", () => {
    for (const capabilities of ALL_CAPABILITY_SETS) {
      expect(isAvailable(AVAILABLE_EVERYWHERE, capabilities)).toBe(true);
    }
  });

  test("a control is offered exactly when the device meets every requirement it lists", () => {
    for (const capabilities of ALL_CAPABILITY_SETS) {
      for (const requirement of ALL_REQUIREMENTS) {
        expect(isAvailable([requirement], capabilities)).toBe(
          capabilities.has(requirement),
        );
      }
      expect(
        isAvailable(
          [REQUIREMENT.sidePanel, REQUIREMENT.desktopAppHost],
          capabilities,
        ),
      ).toBe(capabilities.size === ALL_REQUIREMENTS.length);
    }
  });

  test("filtering keeps the offered controls in their declared order", () => {
    const controls = [
      { id: "download", requires: AVAILABLE_EVERYWHERE },
      { id: "open-in-desktop-app", requires: [REQUIREMENT.desktopAppHost] },
      { id: "move-to-main", requires: [REQUIREMENT.sidePanel] },
      { id: "sign", requires: AVAILABLE_EVERYWHERE },
    ] as const;

    const phone = filterAvailable(controls, new Set());
    expect(phone.map(({ id }) => id)).toEqual(["download", "sign"]);

    const narrowDesktopWindow = filterAvailable(
      controls,
      new Set([REQUIREMENT.desktopAppHost]),
    );
    expect(narrowDesktopWindow.map(({ id }) => id)).toEqual([
      "download",
      "open-in-desktop-app",
      "sign",
    ]);
  });
});
