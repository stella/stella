import { describe, expect, test } from "bun:test";

import { resolveWorkspaceInspectorPresentation } from "./workspace-frame.logic";

describe("workspace inspector presentation", () => {
  test.each([
    [false, false, "desktop"],
    [false, true, "desktop"],
    [true, false, "desktop"],
    [true, true, "mobile"],
  ] as const)(
    "selects exactly one presentation (mobile=%s, compact=%s)",
    (hasMobilePresentation, isCompact, expected) => {
      expect(
        resolveWorkspaceInspectorPresentation({
          hasMobilePresentation,
          isCompact,
        }),
      ).toBe(expected);
    },
  );
});
