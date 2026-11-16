import { describe, expect, test } from "bun:test";

import { readConflictValue } from "@/features/avt/conflict-value.logic";

describe("readConflictValue", () => {
  test("an ISO day or month is a date at that precision", () => {
    expect(readConflictValue("2021-08-10")).toEqual({
      type: "date",
      occurredOn: "2021-08-10",
      precision: "day",
    });
    expect(readConflictValue(" 2021-08 ")).toEqual({
      type: "date",
      occurredOn: "2021-08-01",
      precision: "month",
    });
  });

  test("anything else, an impossible date included, is shown as written", () => {
    for (const value of [
      "£45,000",
      "5 July 2021",
      "2021",
      "2021-02-30",
      "2021-13",
      "dial-in",
    ]) {
      expect(readConflictValue(value)).toEqual({ type: "text", text: value });
    }
  });
});
