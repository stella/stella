import { expect, test } from "bun:test";

import { validateIco } from "./ares/validation.js";
import { initialize } from "./browser.js";

test("browser initialization is shared and makes validators ready", async () => {
  const first = initialize();
  const second = initialize();

  expect(second).toBe(first);
  await first;
  expect(validateIco("27082440")).toBe(true);
});
