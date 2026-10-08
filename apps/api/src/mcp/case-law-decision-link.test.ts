import { expect, test } from "bun:test";

import { decisionBlockDeepLink } from "./case-law-decision-link";

const appUrl = "https://example.test/law/cze/cases/court/decision";

test("decision links prefer court numbers and preserve parser anchors otherwise", () => {
  for (const number of [1, 48, Number.MAX_SAFE_INTEGER]) {
    for (const anchorId of ["p-1", null]) {
      expect(decisionBlockDeepLink({ appUrl, anchorId, number })).toEqual({
        url: `${appUrl}#par=${String(number)}`,
      });
      expect(decisionBlockDeepLink({ appUrl: null, anchorId, number })).toEqual(
        {},
      );
    }
  }

  for (const number of [
    undefined,
    0,
    -1,
    48.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Infinity,
  ]) {
    expect(
      decisionBlockDeepLink({ appUrl, anchorId: "p-1/část", number }),
    ).toEqual({
      url: `${appUrl}#p-1%2F%C4%8D%C3%A1st`,
    });
    expect(decisionBlockDeepLink({ appUrl, anchorId: null, number })).toEqual(
      {},
    );
    expect(
      decisionBlockDeepLink({ appUrl: null, anchorId: "p-1", number }),
    ).toEqual({});
  }
});
