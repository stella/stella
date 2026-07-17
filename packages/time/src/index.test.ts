import { expect, test } from "bun:test";

import { DAY_IN_MS } from "./index";

test("DAY_IN_MS is exactly 24 hours in milliseconds", () => {
  expect(DAY_IN_MS).toBe(24 * 60 * 60 * 1000);
  expect(DAY_IN_MS).toBe(86_400_000);
});
