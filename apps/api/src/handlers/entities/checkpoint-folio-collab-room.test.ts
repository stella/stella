import { describe, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";

import { matchesFolioCollabSnapshotCut } from "./checkpoint-folio-collab-room";

describe("folio collaboration checkpoint snapshot cut", () => {
  const materialized = {
    baseVersionId: createSafeId<"entityVersion">(),
    generation: 3,
    snapshotFileId: createSafeId<"userFile">(),
    snapshotUpdatedAt: new Date("2026-08-29T08:00:00.000Z"),
  };

  test("accepts only the snapshot and base version that were materialized", () => {
    expect(
      matchesFolioCollabSnapshotCut({ current: materialized, materialized }),
    ).toBeTrue();
    expect(
      matchesFolioCollabSnapshotCut({
        current: {
          ...materialized,
          snapshotFileId: createSafeId<"userFile">(),
        },
        materialized,
      }),
    ).toBeFalse();
    expect(
      matchesFolioCollabSnapshotCut({
        current: {
          ...materialized,
          baseVersionId: createSafeId<"entityVersion">(),
        },
        materialized,
      }),
    ).toBeFalse();
    expect(
      matchesFolioCollabSnapshotCut({
        current: {
          ...materialized,
          snapshotUpdatedAt: new Date("2026-08-29T08:00:01.000Z"),
        },
        materialized,
      }),
    ).toBeFalse();
  });
});
