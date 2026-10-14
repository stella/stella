import { expect, test } from "bun:test";

import { handleReaderBackShortcut } from "./navigation";

test("reader back shortcuts consume Escape and Alt+Left only when unhandled", () => {
  for (const key of ["Escape", "ArrowLeft", "ArrowRight", "Enter"]) {
    for (const altKey of [false, true]) {
      for (const blocked of [
        "none",
        "handled",
        "ctrl",
        "meta",
        "shift",
      ] as const) {
        let consumed = false;
        let navigations = 0;
        handleReaderBackShortcut(
          {
            key,
            altKey,
            ctrlKey: blocked === "ctrl",
            metaKey: blocked === "meta",
            shiftKey: blocked === "shift",
            defaultPrevented: blocked === "handled",
            preventDefault: () => {
              consumed = true;
            },
          },
          () => {
            navigations += 1;
          },
        );
        const expected =
          blocked === "none" &&
          ((key === "Escape" && !altKey) || (key === "ArrowLeft" && altKey));
        expect({ key, altKey, blocked, consumed, navigations }).toEqual({
          key,
          altKey,
          blocked,
          consumed: expected,
          navigations: expected ? 1 : 0,
        });
      }
    }
  }
});
