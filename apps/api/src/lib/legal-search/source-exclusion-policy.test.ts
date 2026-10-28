import { expect, test } from "bun:test";

import {
  excludedSourceField,
  SOURCE_EXCLUSION_REASONS,
} from "./ingestion-types";

test("every allowed exclusion names its justification and evidence pointer", () => {
  for (const reason of SOURCE_EXCLUSION_REASONS) {
    expect(
      excludedSourceField({
        reason,
        justification: "The publisher repeats the archived value",
        pointer: "metadata.publisherId",
      }),
    ).toMatchObject({
      disposition: "excluded",
      reason,
      justification: "The publisher repeats the archived value",
      pointer: "metadata.publisherId",
    });
  }
});

test("untyped reasons and missing evidence cannot construct an exclusion", () => {
  expect(() =>
    excludedSourceField({
      // @ts-expect-error Procedural history is legal content, not an exclusion policy.
      reason: "history",
      justification: "Procedural history",
      pointer: "detail.history",
    }),
  ).toThrow("allowed reason");
  expect(() =>
    excludedSourceField({
      reason: "publisher_noise",
      // @ts-expect-error A whitespace justification cannot satisfy the constructor.
      justification: " \n\t",
      pointer: "nav",
    }),
  ).toThrow("justification");
  expect(() =>
    excludedSourceField({
      reason: "duplicate_of",
      justification: "Repeated identifier",
      // @ts-expect-error A whitespace pointer cannot satisfy the constructor.
      pointer: "  ",
    }),
  ).toThrow("pointer");
});
