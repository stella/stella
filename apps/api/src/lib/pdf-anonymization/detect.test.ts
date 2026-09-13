import { expect, test } from "bun:test";

import { selectPdfAnonymizationDetections } from "@/api/lib/pdf-anonymization/detect";

test("removes allowlisted entities while preserving resolved span order", () => {
  expect(
    selectPdfAnonymizationDetections({
      excludedCanonicals: ["  ACME\nCorp "],
      entities: [
        {
          start: 0,
          end: 8,
          text: "Acme Corp",
          label: "organization",
          score: 0.9,
          source: "gazetteer",
        },
        {
          start: 12,
          end: 21,
          text: "Jan Novák",
          label: "person",
          score: 0.9,
          source: "name-corpus",
        },
      ],
    }),
  ).toEqual([{ start: 12, end: 21 }]);
});
