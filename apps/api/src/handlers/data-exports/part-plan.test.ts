import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { planParts } from "@/api/handlers/data-exports/part-plan";
import { DATA_EXPORT_PART_TARGET_BYTES } from "@/api/lib/data-export/queue";
import {
  multipartPartBytes,
  STREAMING_UPLOAD_MAX_EXPECTED_BYTES,
} from "@/api/lib/s3/multipart-sink";

test("organization data can occupy its own admitted first part", () => {
  const organizationBytes = 78 * 1024 ** 3;
  const matterBytes = 1024 ** 3;
  expect(multipartPartBytes(organizationBytes)).not.toBeNull();
  expect(multipartPartBytes(matterBytes)).not.toBeNull();
  expect(multipartPartBytes(organizationBytes + matterBytes)).toBeNull();

  const parts = planParts({
    organizationBytes,
    matters: [{ matterId: "matter", estimatedBytes: matterBytes }],
    targetBytes: DATA_EXPORT_PART_TARGET_BYTES,
  });
  expect(parts).toEqual([
    { index: 1, matterIds: [], estimatedBytes: organizationBytes },
    { index: 2, matterIds: ["matter"], estimatedBytes: matterBytes },
  ]);
  for (const part of parts) {
    expect(multipartPartBytes(part.estimatedBytes)).not.toBeNull();
  }
});

test("export part packing preserves admission for individually admitted units", () => {
  assertProperty(
    "export part packing preserves admission for individually admitted units",
    fc.property(
      fc.record({
        organizationBytes: fc.integer({
          min: 0,
          max: STREAMING_UPLOAD_MAX_EXPECTED_BYTES,
        }),
        targetBytes: fc.integer({
          min: 1,
          max: STREAMING_UPLOAD_MAX_EXPECTED_BYTES,
        }),
        matterBytes: fc.array(
          fc.integer({ min: 0, max: STREAMING_UPLOAD_MAX_EXPECTED_BYTES }),
          { maxLength: 64 },
        ),
      }),
      ({ organizationBytes, targetBytes, matterBytes }) => {
        const matters = matterBytes.map((estimatedBytes, index) => ({
          matterId: `matter-${index}`,
          estimatedBytes,
        }));
        const parts = planParts({ organizationBytes, targetBytes, matters });
        expect(parts.flatMap(({ matterIds }) => matterIds)).toEqual(
          matters.map(({ matterId }) => matterId),
        );
        expect(parts.map(({ index }) => index)).toEqual(
          parts.map((_, index) => index + 1),
        );
        expect(
          parts.reduce((total, part) => total + part.estimatedBytes, 0),
        ).toBe(
          organizationBytes +
            matterBytes.reduce((total, bytes) => total + bytes, 0),
        );
        for (const part of parts) {
          expect(multipartPartBytes(part.estimatedBytes)).not.toBeNull();
        }
      },
    ),
  );
});
