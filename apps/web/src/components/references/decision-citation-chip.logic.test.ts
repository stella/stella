import { describe, expect, test } from "bun:test";

import { citationTextNamesCase } from "@/components/references/decision-citation-chip.logic";

describe("citation text naming its case", () => {
  test("matches the case number whatever the spacing or case", () => {
    expect(citationTextNamesCase("III. ÚS 2429/24", "III.ÚS 2429/24")).toBe(
      true,
    );
    expect(
      citationTextNamesCase(
        "v nálezu iii. ús 2429/24 ze dne",
        "III.ÚS 2429/24",
      ),
    ).toBe(true);
    expect(citationTextNamesCase("27 Cdo 1525/2025", "27 Cdo 1525/2025")).toBe(
      true,
    );
  });

  test("keeps the badge when the prose names another case or none", () => {
    expect(citationTextNamesCase("III. ÚS 2429/23", "III.ÚS 2429/24")).toBe(
      false,
    );
    expect(citationTextNamesCase("tento nález", "III.ÚS 2429/24")).toBe(false);
    expect(citationTextNamesCase("III. ÚS 2429/24", "")).toBe(false);
  });

  test("requires the case number to stand on its own", () => {
    expect(citationTextNamesCase("VIII. ÚS 2429/24", "III.ÚS 2429/24")).toBe(
      false,
    );
    expect(citationTextNamesCase("III. ÚS 2429/240", "III.ÚS 2429/24")).toBe(
      false,
    );
    expect(citationTextNamesCase("(III. ÚS 2429/24).", "III.ÚS 2429/24")).toBe(
      true,
    );
  });
});
