import { describe, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";

import {
  matchesFolioCollabCheckpointCut,
  matchesFolioCollabPublishedCut,
  isFolioCollabIdempotencyConstraintError,
} from "./publish-folio-collab-version";

describe("folio collaboration publication cut", () => {
  const checkpointFileId = createSafeId<"userFile">();
  const expectedSha256Hex = "a".repeat(64);
  const checkpoint = {
    checkpointFileId,
    checkpointSha256Hex: expectedSha256Hex,
    checkpointUpdatedAt: new Date("2026-08-29T00:00:00.000Z"),
    generation: 4,
  };

  test("accepts only the exact immutable checkpoint cut", () => {
    expect(
      matchesFolioCollabCheckpointCut({
        checkpoint,
        expectedFileId: checkpointFileId,
        expectedGeneration: 4,
        expectedSha256Hex,
      }),
    ).toBeTrue();

    expect(
      matchesFolioCollabCheckpointCut({
        checkpoint,
        expectedFileId: checkpointFileId,
        expectedGeneration: 5,
        expectedSha256Hex,
      }),
    ).toBeFalse();
    expect(
      matchesFolioCollabCheckpointCut({
        checkpoint,
        expectedFileId: checkpointFileId,
        expectedGeneration: 4,
        expectedSha256Hex: "b".repeat(64),
      }),
    ).toBeFalse();
    expect(
      matchesFolioCollabCheckpointCut({
        checkpoint,
        expectedFileId: createSafeId<"userFile">(),
        expectedGeneration: 4,
        expectedSha256Hex,
      }),
    ).toBeFalse();
    expect(
      matchesFolioCollabCheckpointCut({
        checkpoint: { ...checkpoint, checkpointUpdatedAt: null },
        expectedFileId: checkpointFileId,
        expectedGeneration: 4,
        expectedSha256Hex,
      }),
    ).toBeFalse();
  });

  test("serializes publish through the room lock and canonical writer", async () => {
    const source = await Bun.file(
      import.meta.path.replace(".test.ts", ".ts"),
    ).text();
    const transactionStart = source.indexOf("const publicationResult =");
    const roomLock = source.indexOf('.for("update")', transactionStart);
    const canonicalWrite = source.indexOf(
      "const versionWrite = await writeFileVersion",
      transactionStart,
    );

    expect(transactionStart).toBeGreaterThan(-1);
    expect(roomLock).toBeGreaterThan(transactionStart);
    expect(canonicalWrite).toBeGreaterThan(roomLock);
    expect(source).toContain(
      "eq(folioCollabRooms.generation, expectedGeneration)",
    );
    expect(source).toMatch(
      /eq\(\s*folioCollabRooms\.docxCheckpointSha256Hex,\s*expectedSha256Hex,?\s*\)/u,
    );
  });

  test("binds an idempotency key to one room, generation, and hash", () => {
    const roomId = createSafeId<"folioCollabRoom">();
    const published = {
      checkpointSha256Hex: expectedSha256Hex,
      generation: 4,
      roomId,
    };
    expect(
      matchesFolioCollabPublishedCut({
        expectedGeneration: 4,
        expectedSha256Hex,
        published,
        roomId,
      }),
    ).toBeTrue();
    expect(
      matchesFolioCollabPublishedCut({
        expectedGeneration: 5,
        expectedSha256Hex,
        published,
        roomId,
      }),
    ).toBeFalse();
    expect(
      matchesFolioCollabPublishedCut({
        expectedGeneration: 4,
        expectedSha256Hex: "b".repeat(64),
        published,
        roomId,
      }),
    ).toBeFalse();
    expect(
      matchesFolioCollabPublishedCut({
        expectedGeneration: 4,
        expectedSha256Hex,
        published,
        roomId: createSafeId<"folioCollabRoom">(),
      }),
    ).toBeFalse();
  });

  test("recognizes the global idempotency constraint through safe-db errors", () => {
    expect(
      isFolioCollabIdempotencyConstraintError(
        new DatabaseError({
          cause: {
            code: "23505",
            constraint: "folio_collab_publications_idempotency_uidx",
          },
          code: "23505",
          message: "Database query failed",
        }),
      ),
    ).toBeTrue();
    expect(
      isFolioCollabIdempotencyConstraintError(
        new DatabaseError({
          cause: { code: "23505", constraint: "entity_versions_uidx" },
          code: "23505",
          message: "Database query failed",
        }),
      ),
    ).toBeFalse();
  });
});
