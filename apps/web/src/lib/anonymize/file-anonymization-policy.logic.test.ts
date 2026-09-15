import { expect, test } from "bun:test";

import { collectFileAnonymizationTerms } from "./file-anonymization-policy.logic";

test("exclusions apply to each detected and vocabulary surface independently", () => {
  const vocabulary = [
    {
      enabled: true,
      canonical: "Example Holdings",
      label: "organization",
      variants: ["Example Ltd", "Example Group"],
    },
  ];
  expect(
    collectFileAnonymizationTerms({
      detected: [{ original: "ＥＸＡＭＰＬＥ　ＬＴＤ", label: "organization" }],
      vocabulary,
      excludedCanonicals: ["example ltd", "Example Holdings"],
    }),
  ).toEqual([{ text: "Example Group", label: "organization" }]);
});

test("disabled vocabulary cannot introduce masks and duplicate detections collapse", () => {
  expect(
    collectFileAnonymizationTerms({
      detected: [
        { original: "Example Ltd", label: "organization" },
        { original: "Example Ltd", label: "organization" },
      ],
      vocabulary: [
        {
          enabled: false,
          canonical: "Hidden Corp",
          label: "organization",
          variants: ["Hidden"],
        },
      ],
      excludedCanonicals: [],
    }),
  ).toEqual([{ text: "Example Ltd", label: "organization" }]);
});
