import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { tExemptionReason } from "./invoice-lines";

describe("invoice line exemption basis", () => {
  test("refuses a blank basis that would print as no basis at all", () => {
    for (const blank of ["", " ", "\t", " \n "]) {
      expect(Value.Check(tExemptionReason, blank), JSON.stringify(blank)).toBe(
        false,
      );
    }
  });

  test("accepts a stated basis and an explicit clear", () => {
    expect(Value.Check(tExemptionReason, "art. 43 ust. 1 pkt 37")).toBe(true);
    expect(Value.Check(tExemptionReason, " § 38 ")).toBe(true);
    expect(Value.Check(tExemptionReason, null)).toBe(true);
  });
});
