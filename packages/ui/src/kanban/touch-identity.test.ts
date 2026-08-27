import { describe, expect, test } from "bun:test";

import { isActiveTouchChange } from "./touch-identity";

describe("touch identity", () => {
  test("forwards only lifecycle changes from the activating finger", () => {
    for (const eventType of ["move", "end", "cancel"]) {
      expect(
        isActiveTouchChange({
          activeTouchIdentifier: 1,
          changedTouchIdentifiers: [2],
        }),
        `secondary ${eventType}`,
      ).toBeFalse();
      expect(
        isActiveTouchChange({
          activeTouchIdentifier: 1,
          changedTouchIdentifiers: [1],
        }),
        `primary ${eventType}`,
      ).toBeTrue();
    }
  });

  test("forwards lifecycle changes when the activating event lacks an identifier", () => {
    expect(
      isActiveTouchChange({
        activeTouchIdentifier: null,
        changedTouchIdentifiers: [2],
      }),
    ).toBeTrue();
  });
});
