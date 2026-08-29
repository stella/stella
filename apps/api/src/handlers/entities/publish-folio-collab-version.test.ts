import { describe, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";

import { matchesFolioCollabCheckpointCut } from "./publish-folio-collab-version";

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
    const transactionStart = source.indexOf("const publication =");
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
});
