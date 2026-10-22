import { expect, test } from "bun:test";

import pl from "../src/i18n/langs/pl.json";

test("the never-requested label says the app never asks", () => {
  expect(pl.onboarding.neverRequested).toBe("Aplikacja nigdy nie prosi o:");
});
