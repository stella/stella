import { expect, test } from "bun:test";

import pl from "./pl.json";

test("the never-requested label says the app never asks", () => {
  expect(pl.onboarding.neverRequested).toBe("Aplikacja nigdy nie prosi o:");
});
