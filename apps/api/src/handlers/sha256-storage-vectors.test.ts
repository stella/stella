import { expect, test } from "bun:test";

import { hashBundledSkillPackage } from "./catalogue/bundled-skill-resources";
import { fingerprintContactImport } from "./contacts/contact-import-receipt";
import { suggestionFingerprint } from "./time-entries/suggestions/cluster";

const text = "Článek\u0000📄\ud800";

test("bundled skill identity preserves resource order and NUL framing", () => {
  const resources = [
    {
      path: "references/a.md",
      content: "a\u0000b",
      kind: "reference",
      sizeBytes: 3,
    },
    { path: "templates/b.txt", content: text, kind: "template", sizeBytes: 1 },
  ] as const;
  expect(hashBundledSkillPackage({ source: text, resources })).toBe(
    "09b528caae027f28260e2aabbc3d491765ae396aa4d0410abaa303b2eb42c488",
  );
  expect(
    hashBundledSkillPackage({
      source: text,
      resources: resources.toReversed(),
    }),
  ).not.toBe(hashBundledSkillPackage({ source: text, resources }));
});

test("contact receipt preserves canonical JSON and absent optional fields", () => {
  expect(
    fingerprintContactImport([
      { z: undefined, a: text, nested: { b: null, a: [1, false] } },
    ]),
  ).toBe("4b47ecd3b11a2d008ec60799ebf6588bb88658d184e7b0a03dd40a6181e8df2d");
  expect(fingerprintContactImport([])).toBe(
    "e0e9ee388dfe75b496ce9c2cc02ea0282da646892ff5115a53b02c116a5cf8ae",
  );
});

test("suggestion identity preserves the date separator and UTF-8 encoding", () => {
  expect(suggestionFingerprint("2026-01-01", text)).toBe(
    "410868e7c467def10d1734ace54d248f153b5fe6621a950c7a95d86164bff963",
  );
  expect(suggestionFingerprint("2026-01-01", "a\nb")).toBe(
    "273a764f73a1bd3e465e3b4bdd025fa0dea78c38e5a6be591217bf943c734cd6",
  );
});
