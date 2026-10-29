import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register();
const { cleanup, render } = await import("@testing-library/react");
const { Dialog, DialogPopup, DialogTitle } = await import("./dialog");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const popupFor = (size?: "sm" | "default" | "lg" | "xl") => {
  render(
    <Dialog defaultOpen>
      <DialogPopup size={size}>
        <DialogTitle>Review</DialogTitle>
      </DialogPopup>
    </Dialog>,
  );
  const popup = document.querySelector<HTMLElement>(
    '[data-slot="dialog-popup"]',
  );
  if (popup === null) {
    throw new Error("Expected an open dialog popup");
  }
  return popup;
};

describe("DialogPopup size", () => {
  test("is a short-form width by default", () => {
    const popup = popupFor();
    expect(popup.dataset["size"]).toBe("default");
    expect(popup.classList.contains("max-w-lg")).toBe(true);
  });

  for (const [size, width] of [
    ["sm", "max-w-sm"],
    ["lg", "max-w-2xl"],
    ["xl", "max-w-4xl"],
  ] as const) {
    test(`${size} sets the popup to ${width}`, () => {
      const popup = popupFor(size);
      expect(popup.dataset["size"]).toBe(size);
      expect(popup.classList.contains(width)).toBe(true);
      expect(popup.classList.contains("max-w-lg")).toBe(false);
    });
  }
});
