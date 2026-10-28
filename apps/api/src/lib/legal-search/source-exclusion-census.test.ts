import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

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
    status: "audited",
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

test("an empty publisher observation is unavailable rather than audited clean", () => {
  expect(publisherFieldRetentionAudit({ fields: {} }, [])).toEqual({
    status: "unavailable",
    reason: "no-observed-fields",
  });
});

test("publisher-field-retention: prototype names count only when explicitly mapped", async () => {
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype);
  await assertProperty(
    "publisher-field-retention: prototype names count only when explicitly mapped",
    fc.property(
      fc.subarray(prototypeNames),
      fc.array(fc.string(), { maxLength: 20 }),
      (ownNames, extraNames) => {
        const fields = Object.fromEntries(
          ownNames.map((name) => [
            name,
            { disposition: "stored", target: { type: "identity" } } as const,
          ]),
        );
        const observed = [...new Set([...prototypeNames, ...extraNames])];
        const audit = publisherFieldRetentionAudit({ fields }, observed);
        expect(audit.status).toBe("audited");
        if (audit.status !== "audited") {
          throw new TypeError(
            "A nonempty publisher observation was unavailable",
          );
        }
        expect(audit.observedFieldCount).toBe(observed.length);
        expect(audit.unmappedFields).toEqual(
          observed.filter((field) => !ownNames.includes(field)),
        );
        expect(audit.excludedFields).toEqual([]);
      },
    ),
  );
});
