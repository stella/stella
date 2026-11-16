import { describe, expect, test } from "bun:test";

import type { CellMetadata, CellOverride } from "@/api/db/schema-validators";
import {
  activeCellOverride,
  carriedCellMetadata,
  nextCellOverride,
} from "@/api/lib/fields/cell-override";

const machineText = { version: 1, type: "text", value: "Acme Ltd" } as const;
const humanText = { version: 1, type: "text", value: "Acme Holdings" } as const;
const settled = {
  type: "value",
  runId: "run-1",
  settledAt: "2026-11-04T10:00:00.000Z",
} as const;

const override: CellOverride = {
  machine: { content: machineText, settlement: settled, justification: null },
  editedBy: "user-a",
  editedAt: "2026-11-04T11:00:00.000Z",
  reason: "Registry shows the full name",
};

const metadata: CellMetadata = {
  version: 1,
  manualFlags: [],
  locked: true,
  override,
};

describe("nextCellOverride", () => {
  test("replacing a run's value captures it, with no reason yet", () => {
    expect(
      nextCellOverride({
        existing: undefined,
        replaced: {
          content: machineText,
          aiSettlement: settled,
          justification: null,
        },
        editedBy: "user-b",
        editedAt: "2026-11-04T12:00:00.000Z",
      }),
    ).toEqual({
      machine: {
        content: machineText,
        settlement: settled,
        justification: null,
      },
      editedBy: "user-b",
      editedAt: "2026-11-04T12:00:00.000Z",
      reason: null,
    });
  });

  test("a run's not-stated finding is a machine outcome too", () => {
    const notStated = { ...settled, type: "notStated" } as const;
    expect(
      nextCellOverride({
        existing: undefined,
        replaced: {
          content: { version: 1, type: "unsupported" },
          aiSettlement: notStated,
          justification: null,
        },
        editedBy: "user-b",
        editedAt: "2026-11-04T12:00:00.000Z",
      })?.machine.settlement,
    ).toEqual(notStated);
  });

  test("replacing a person's value keeps the machine original and its reason", () => {
    expect(
      nextCellOverride({
        existing: override,
        replaced: {
          content: humanText,
          aiSettlement: null,
          justification: null,
        },
        editedBy: "user-b",
        editedAt: "2026-11-04T12:00:00.000Z",
      }),
    ).toEqual({
      ...override,
      editedBy: "user-b",
      editedAt: "2026-11-04T12:00:00.000Z",
    });
  });

  test("a failed run left nothing to keep", () => {
    expect(
      nextCellOverride({
        existing: undefined,
        replaced: {
          content: { version: 1, type: "error" },
          aiSettlement: { ...settled, type: "failed" },
          justification: null,
        },
        editedBy: "user-b",
        editedAt: "2026-11-04T12:00:00.000Z",
      }),
    ).toBeUndefined();
  });
});

describe("activeCellOverride", () => {
  test("holds while the current value is a person's", () => {
    expect(activeCellOverride({ metadata, aiSettlement: null })).toBe(override);
    expect(activeCellOverride({ metadata, aiSettlement: undefined })).toBe(
      override,
    );
  });

  test("is stale once a run settles the cell again", () => {
    expect(
      activeCellOverride({ metadata, aiSettlement: settled }),
    ).toBeUndefined();
  });
});

describe("carriedCellMetadata", () => {
  test("carries the override and nothing else", () => {
    expect(carriedCellMetadata(metadata)).toEqual({ override });
    expect(carriedCellMetadata(undefined)).toEqual({});
  });
});
