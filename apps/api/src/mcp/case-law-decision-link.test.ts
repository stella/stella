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
      url: `${appUrl}#p-1/%C4%8D%C3%A1st`,
    });
    expect(decisionBlockDeepLink({ appUrl, anchorId: null, number })).toEqual(
      {},
    );
    expect(
      decisionBlockDeepLink({ appUrl: null, anchorId: "p-1", number }),
    ).toEqual({});
  }
});

test("unnumbered anchor links round-trip through the reader's URI decoding", () => {
  for (const anchorId of [
    "p-1/část",
    "p-1;,:@&=+$?/#",
    "p-1%2F",
    "p-1 space",
    "p-1😀",
  ]) {
    const link = decisionBlockDeepLink({ appUrl, anchorId });
    if (link.url === undefined) {
      throw new Error("Expected an unnumbered anchor link");
    }
    expect(decodeURI(new URL(link.url).hash.slice(1))).toBe(anchorId);
  }
});
