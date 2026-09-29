import { describe, expect, test } from "bun:test";

import { hoursQuantity } from "./invoice-lines";

describe("hoursQuantity", () => {
  test.each([
    [0, "0"],
    [60, "1"],
    [600, "10"],
    [90, "1.5"],
    [606, "10.1"],
    [6, "0.1"],
    [3, "0.05"],
    [10, "0.1667"],
    [1, "0.0167"],
  ])("%p billed minutes are %p hours", (minutes, hours) => {
    expect(hoursQuantity(minutes)).toBe(hours);
  });
});
