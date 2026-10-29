import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type * as TestingLibrary from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import { Dialog, DialogPopup, type DialogSize, DialogTitle } from "./dialog";

// Registered for this file only, and the testing library loaded after it,
// so the shared test process keeps one happy-dom at a time.
let library: typeof TestingLibrary;

beforeAll(async () => {
  GlobalRegistrator.register();
  library = await import("@testing-library/react");
});

afterEach(() => {
  library.cleanup();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** The open popup, once the portal has mounted it. */
const popupFor = async (size?: DialogSize): Promise<HTMLElement> => {
  library.render(
    <Dialog defaultOpen>
      <DialogPopup size={size}>
        <DialogTitle>Review</DialogTitle>
      </DialogPopup>
    </Dialog>,
  );
  return library.waitFor(() => {
    const popup = document.querySelector<HTMLElement>(
      '[data-slot="dialog-popup"]',
    );
    if (popup === null) {
      throw new Error("The dialog popup has not mounted yet");
    }
    return popup;
  });
};

describe("DialogPopup size", () => {
  test("is a short-form width by default", async () => {
    const popup = await popupFor();
    expect(popup.dataset["size"]).toBe("default");
    expect(popup.classList.contains("max-w-lg")).toBe(true);
  });

  for (const [size, width] of [
    ["sm", "max-w-sm"],
    ["lg", "max-w-2xl"],
    ["xl", "max-w-4xl"],
  ] as const) {
    test(`${size} sets the popup to ${width}`, async () => {
      const popup = await popupFor(size);
      expect(popup.dataset["size"]).toBe(size);
      expect(popup.classList.contains(width)).toBe(true);
      expect(popup.classList.contains("max-w-lg")).toBe(false);
    });
  }
});
