import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  publicLawPageSearchSchema,
  publicLawPageSizeSearchSchema,
} from "@/components/public-law-table/public-law-route-pagination.logic";

describe("numeric pagination query tokens", () => {
  test("accepts whole decimal tokens and falls back for prefixes or coercible junk", () => {
    expect(v.parse(publicLawPageSearchSchema, "2")).toBe(2);
    for (const token of ["2pages", " 2", "+2", "2.0", "0x2", ""]) {
      expect(v.parse(publicLawPageSearchSchema, token)).toBeUndefined();
    }
  });

  test("accepts only offered page sizes as whole decimal tokens", () => {
    expect(v.parse(publicLawPageSizeSearchSchema, "100")).toBe(100);
    for (const token of ["50items", " 50", "+50", "50.0", "0x32"]) {
      expect(v.parse(publicLawPageSizeSearchSchema, token)).toBeUndefined();
    }
  });
});
