import { expect, test } from "bun:test";

import { excludedSourceField } from "./ingestion-types";
import { publisherFieldRetentionAudit } from "./source-exclusion-census";

test("the shared publisher audit reports observed exclusions with evidence and new fields separately", () => {
  const inventory = {
    fields: {
      id: { disposition: "stored", target: { type: "identity" } },
      repeatedId: excludedSourceField({
        reason: "duplicate_of",
        justification: "The publisher repeats its primary identifier",
        pointer: "id",
      }),
      navigation: excludedSourceField({
        reason: "publisher_noise",
        justification: "Navigation links contain no decision content",
        pointer: "header.navigation",
      }),
    },
  } as const;

  expect(
    publisherFieldRetentionAudit(inventory, [
      "id",
      "repeatedId",
      "addedByPublisher",
      "addedByPublisher",
    ]),
  ).toEqual({
    observedFieldCount: 3,
    unmappedFields: ["addedByPublisher"],
    excludedFields: [
      {
        field: "repeatedId",
        policy: "justified",
        reason: "duplicate_of",
        justification: "The publisher repeats its primary identifier",
        pointer: "id",
      },
    ],
  });
});
