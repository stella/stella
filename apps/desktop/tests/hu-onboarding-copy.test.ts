import { expect, test } from "bun:test";

import hu from "../src/i18n/langs/hu.json";

test("the never-requested label says the app never asks", () => {
  expect(hu.onboarding.neverRequested).toBe("Az alkalmazás soha nem kéri:");
});
