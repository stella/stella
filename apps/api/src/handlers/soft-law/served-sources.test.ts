import { expect, test } from "bun:test";

import {
  SOFT_LAW_SERVE_MODE,
  softLawServingSettingOf,
} from "@/api/lib/legal-search/soft-law-serving";

import { SOFT_LAW_ADMISSIONS } from "./adapters/registry";
import { servedRegisteredSoftLawAuthorities } from "./served-sources";

test("a schedule acquires only registered sources with a decision to serve them", () => {
  const authorities = servedRegisteredSoftLawAuthorities();
  expect(authorities).toContain("eu-edpb");
  for (const notServed of ["eu-wp29", "de-bfdi", "sk-uoou"]) {
    expect(authorities).not.toContain(notServed);
  }
  for (const authority of authorities) {
    expect(SOFT_LAW_ADMISSIONS[authority].state).toBe("registered");
    expect(softLawServingSettingOf(authority).serve).not.toBe(
      SOFT_LAW_SERVE_MODE.none,
    );
  }
});
