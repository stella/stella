import { describe, expect, test } from "bun:test";

import { isExtensionActive } from "./action-icon";
import { DESKTOP_LINK_STATE } from "./desktop-link";

describe("extension toolbar active icon", () => {
  test("is active when a web controller is paired", () => {
    expect(
      isExtensionActive({
        desktopState: DESKTOP_LINK_STATE.offline,
        hasController: true,
      }),
    ).toBe(true);
  });

  test("is active when stella desktop is connected even without a web tab", () => {
    expect(
      isExtensionActive({
        desktopState: DESKTOP_LINK_STATE.connected,
        hasController: false,
      }),
    ).toBe(true);
  });

  test("is inactive when neither web nor desktop is connected", () => {
    for (const desktopState of [
      DESKTOP_LINK_STATE.offline,
      DESKTOP_LINK_STATE.waiting,
      DESKTOP_LINK_STATE.incompatible,
    ]) {
      expect(
        isExtensionActive({
          desktopState,
          hasController: false,
        }),
      ).toBe(false);
    }
  });
});
