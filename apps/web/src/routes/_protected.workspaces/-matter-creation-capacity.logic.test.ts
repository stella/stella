import { describe, expect, test } from "bun:test";

import { isMatterInStatusView } from "@/lib/workspaces/archived-matters.logic";

import { hasMatterCreationCapacity } from "./-matter-creation-capacity.logic";

describe("matter creation capacity", () => {
  test("depends only on active matters in every view", () => {
    const belowLimit = [
      { status: "active" },
      { status: "active" },
      ...Array.from({ length: 5 }, () => ({ status: "archived" })),
    ];
    const atLimit = Array.from({ length: 3 }, () => ({ status: "active" }));

    expect(
      belowLimit.filter(({ status }) => isMatterInStatusView(status, "active")),
    ).toHaveLength(2);
    expect(
      belowLimit.filter(({ status }) =>
        isMatterInStatusView(status, "archived"),
      ),
    ).toHaveLength(5);
    expect(hasMatterCreationCapacity(belowLimit, 3)).toBe(true);

    expect(
      atLimit.filter(({ status }) => isMatterInStatusView(status, "active")),
    ).toHaveLength(3);
    expect(
      atLimit.filter(({ status }) => isMatterInStatusView(status, "archived")),
    ).toHaveLength(0);
    expect(hasMatterCreationCapacity(atLimit, 3)).toBe(false);
  });
});
