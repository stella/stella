import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  carriedCellMetadata,
  carriedJustifications,
  carriedSettlement,
} from "@/api/lib/entity-versions/carry-cell-state";

const price = toSafeId<"property">("price");
const notes = toSafeId<"property">("notes");
const uploader = toSafeId<"user">("uploader");
const context = {
  affectedPropertyIds: new Set([price]),
  sourceVersionId: toSafeId<"entityVersion">("v1"),
  now: "2026-11-12T09:00:00.000Z",
};
const settled = {
  type: "value",
  runId: "run-1",
  settledAt: "2026-11-04T10:00:00.000Z",
} as const;

describe("carriedSettlement", () => {
  test("marks an affected outcome stale and keeps the rest of it", () => {
    expect(
      carriedSettlement({ settlement: settled, propertyId: price, context }),
    ).toEqual({
      ...settled,
      stale: {
        reason: "input-changed",
        since: context.now,
        settledOnEntityVersionId: "v1",
      },
    });
  });

  test("keeps the first staleness across further versions", () => {
    const first = {
      reason: "input-changed",
      since: "2026-11-05T00:00:00.000Z",
      settledOnEntityVersionId: "v0",
    } as const;
    expect(
      carriedSettlement({
        settlement: { ...settled, stale: first },
        propertyId: price,
        context,
      })?.stale,
    ).toEqual(first);
  });

  test("a column not reading the file, and a hand value, carry unchanged", () => {
    expect(
      carriedSettlement({ settlement: settled, propertyId: notes, context }),
    ).toBe(settled);
    expect(
      carriedSettlement({ settlement: null, propertyId: price, context }),
    ).toBeNull();
  });
});

describe("carriedJustifications", () => {
  test("citations follow their cell; the replaced file keeps its old field", () => {
    const oldFile = toSafeId<"field">("file-v1");
    const annex = toSafeId<"field">("annex-v1");
    const cell = toSafeId<"field">("price-v1");
    const content = { version: 1, blocks: [] } as const;
    expect(
      carriedJustifications({
        justifications: [
          {
            fieldId: cell,
            content,
            boundingBoxes: null,
            fileFieldIds: [oldFile, annex],
          },
        ],
        revisionFieldIdBySourceId: new Map([
          [cell, toSafeId<"field">("price-v2")],
          [oldFile, toSafeId<"field">("file-v2")],
          [annex, toSafeId<"field">("annex-v2")],
        ]),
        replacedFileFieldIds: new Set([oldFile]),
      }),
    ).toEqual([
      {
        fieldId: toSafeId<"field">("price-v2"),
        content,
        boundingBoxes: null,
        fileFieldIds: [oldFile, toSafeId<"field">("annex-v2")],
      },
    ]);
  });
});

describe("carriedCellMetadata", () => {
  test("a person's cell whose inputs changed asks for review, value untouched", () => {
    expect(
      carriedCellMetadata({
        metadata: { version: 1, manualFlags: ["verified"], locked: true },
        propertyId: price,
        context,
        userId: uploader,
      }),
    ).toEqual({
      version: 1,
      manualFlags: ["verified", "needs-review"],
      locked: true,
      flagProvenance: {
        "needs-review": { addedBy: uploader, addedAt: context.now },
      },
    });
  });

  test("unlocked cells and unaffected columns keep their metadata", () => {
    const unlocked = { version: 1 as const, manualFlags: [] };
    expect(
      carriedCellMetadata({
        metadata: unlocked,
        propertyId: price,
        context,
        userId: uploader,
      }),
    ).toBe(unlocked);
    const locked = {
      version: 1 as const,
      manualFlags: [],
      locked: true,
    };
    expect(
      carriedCellMetadata({
        metadata: locked,
        propertyId: notes,
        context,
        userId: uploader,
      }),
    ).toBe(locked);
  });
});
