import { expect, test } from "bun:test";

import { toImportReviewSeedRows } from "@/routes/_protected.contacts/-import-review";

test("keeps possible-duplicate warnings when validated candidates seed review", () => {
  const rows = toImportReviewSeedRows([
    {
      contact: { displayName: "John Smith", type: "person" },
      issues: [],
      rowNumber: 1,
      warnings: [],
    },
    {
      contact: { displayName: "John Smith", type: "person" },
      issues: [],
      rowNumber: 2,
      warnings: [
        {
          code: "possible_in_file_duplicate",
          duplicateOfRowNumber: 1,
          rowNumber: 2,
        },
      ],
    },
  ]);

  expect(rows.at(1)?.warnings).toEqual([
    {
      code: "possible_in_file_duplicate",
      duplicateOfRowNumber: 1,
      rowNumber: 2,
    },
  ]);
});
