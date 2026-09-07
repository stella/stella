import { describe, expect, test } from "bun:test";

import { spanPresentation } from "@/routes/dev/-components/avt/verification-view.logic";

describe("spanPresentation", () => {
  const cases: {
    matches: boolean;
    filterActive: boolean;
    expected: { dim: boolean; highlight: boolean };
  }[] = [
    {
      matches: false,
      filterActive: false,
      expected: { dim: false, highlight: false },
    },
    {
      matches: true,
      filterActive: false,
      expected: { dim: false, highlight: false },
    },
    {
      matches: false,
      filterActive: true,
      expected: { dim: true, highlight: false },
    },
    {
      matches: true,
      filterActive: true,
      expected: { dim: false, highlight: true },
    },
  ];

  for (const { matches, filterActive, expected } of cases) {
    test(`matches=${matches} filterActive=${filterActive}`, () => {
      expect(spanPresentation({ matches, filterActive })).toEqual(expected);
    });
  }

  test("never dims and highlights the same claim at once", () => {
    for (const matches of [true, false]) {
      for (const filterActive of [true, false]) {
        const { dim, highlight } = spanPresentation({ matches, filterActive });
        expect(dim && highlight).toBe(false);
      }
    }
  });
});
