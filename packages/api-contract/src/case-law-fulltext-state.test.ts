import { expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty, propertyConfig } from "@stll/property-testing";

import { decisionTextStateSchema } from "./case-law-fulltext-state";

const proofWith = (verifiedAt: string) => ({
  status: "stored",
  storage: "postgres",
  contentHash: "a".repeat(64),
  verifiedAt,
});

test("untrusted text-state timestamps return validation results without throwing", () => {
  assertProperty(
    "case-law-text-state-timestamps-validate-without-throwing",
    fc.property(fc.string(), (value) => {
      const result = v.safeParse(decisionTextStateSchema, proofWith(value));
      expect(typeof result.success).toBe("boolean");
      if (result.success) {
        expect(result.output).toMatchObject({ verifiedAt: value });
      }
    }),
    propertyConfig(),
  );
});

test.each(["bad", "", "2026-02-30T12:00:00.000Z", "2026-10-28T12:00:00Z"])(
  "rejects noncanonical timestamp %s",
  (value) => {
    expect(v.safeParse(decisionTextStateSchema, proofWith(value)).success).toBe(
      false,
    );
  },
);

test("accepts canonical UTC proof timestamps", () => {
  expect(
    v.safeParse(decisionTextStateSchema, proofWith("2026-10-28T12:00:00.000Z"))
      .success,
  ).toBe(true);
});
