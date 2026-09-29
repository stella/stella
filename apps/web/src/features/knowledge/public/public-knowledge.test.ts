import { describe, expect, test } from "bun:test";

import { toCatalogueStarters } from "@/features/knowledge/public/public-knowledge";

const STARTER = {
  id: "nda",
  name: "NDA",
  description: "Mutual NDA",
  positionCount: 12,
};

describe("toCatalogueStarters", () => {
  test("a failed read with nothing to show is an error the visitor can retry", () => {
    let retries = 0;
    const starters = toCatalogueStarters(
      { data: undefined, isLoading: false, isError: true },
      () => {
        retries += 1;
      },
    );

    expect(starters.status).toBe("error");
    expect(starters.items).toEqual([]);
    starters.retry?.();
    expect(retries).toBe(1);
  });

  test("a read still on its way is loading", () => {
    expect(
      toCatalogueStarters(
        { data: undefined, isLoading: true, isError: false },
        () => undefined,
      ).status,
    ).toBe("loading");
  });

  test("a successful read lists the starters, and keeps them if a later read fails", () => {
    for (const isError of [false, true]) {
      const starters = toCatalogueStarters(
        { data: [STARTER], isLoading: false, isError },
        () => undefined,
      );
      expect(starters.status).toBe("ready");
      expect(starters.items).toEqual([
        {
          starterId: "nda",
          name: "NDA",
          description: "Mutual NDA",
          positionCount: 12,
        },
      ]);
    }
  });
});
