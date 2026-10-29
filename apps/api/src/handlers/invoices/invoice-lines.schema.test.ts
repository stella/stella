import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { tExemptionReason } from "@/api/lib/billing/invoice-lines";

describe("invoice line exemption basis", () => {
  test("refuses a blank basis that would print as no basis at all", () => {
    for (const blank of ["", " ", "\t", " \n "]) {
      expect(v.is(tExemptionReason, blank), JSON.stringify(blank)).toBe(false);
    }
  });

  test("accepts a stated basis and an explicit clear", () => {
    expect(v.is(tExemptionReason, "art. 43 ust. 1 pkt 37")).toBe(true);
    expect(v.is(tExemptionReason, " § 38 ")).toBe(true);
    expect(v.is(tExemptionReason, null)).toBe(true);
  });
});
