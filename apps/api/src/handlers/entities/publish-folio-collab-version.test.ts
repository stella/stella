import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { sha256Hex as legacySha256Hex } from "@stll/sha256/node";

import { envBase } from "@/api/env-base";
import { createSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testFileKey } from "@/api/tests/helpers/file-key";

import {
  readPublishableCheckpoint,
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
    const lockStart = source.indexOf("const lockPublicationRoom =");
    const lockEnd = source.indexOf("type LockedPublicationRoom", lockStart);
    const transactionStart = source.indexOf(
      "const publishCheckpointInTransaction =",
    );
    const roomLock = source.indexOf(
      "await lockPublicationRoom(",
      transactionStart,
    );
    const canonicalWrite = source.indexOf(
      "const versionWrite = await writeFileVersion",
      transactionStart,
    );

    expect(lockStart).toBeGreaterThan(-1);
    expect(source.slice(lockStart, lockEnd)).toContain('.for("update")');
    expect(transactionStart).toBeGreaterThan(-1);
    expect(roomLock).toBeGreaterThan(transactionStart);
    expect(canonicalWrite).toBeGreaterThan(roomLock);
    expect(source).toMatch(
      /safeDb\(\s*async \(tx\) =>\s*await publishCheckpointInTransaction\(/u,
    );
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

describe("publication validates the stored checkpoint identity", () => {
  test.each(["", "ordinary", "Žluťoučký kůň Łódź", "e\u0301"])(
    "accepts the legacy digest of exact DOCX bytes: %j",
    async (text) => {
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      );
      zip.file(
        "word/document.xml",
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      );
      const bytes = new Uint8Array(
        await zip.generateAsync({ type: "arraybuffer" }),
      );
      const store = startFakeS3();
      const checkpointKey = testFileKey(
        "user-files/publication-checkpoint.docx",
      );
      store.put(envBase.S3_BUCKET, checkpointKey, bytes, DOCX_MIME_TYPE);
      const expectedSha256Hex = legacySha256Hex(bytes);
      try {
        const result = await readPublishableCheckpoint({
          checkpointKey,
          expectedSha256Hex,
          fileName: "checkpoint.docx",
          signal: AbortSignal.timeout(5000),
        });
        if (Result.isError(result)) {
          panic(`valid checkpoint refused: ${result.error.message}`);
        }
        expect(result.value).toEqual(bytes);
        const altered = Uint8Array.from(bytes);
        altered[0] = 0;
        expect(legacySha256Hex(altered)).not.toBe(expectedSha256Hex);
        store.put(envBase.S3_BUCKET, checkpointKey, altered, DOCX_MIME_TYPE);
        const changed = await readPublishableCheckpoint({
          checkpointKey,
          expectedSha256Hex,
          fileName: "checkpoint.docx",
          signal: AbortSignal.timeout(5000),
        });
        expect(Result.isError(changed)).toBe(true);
        if (Result.isOk(changed)) {
          panic("changed checkpoint bytes were accepted");
        }
        expect(changed.error).toMatchObject({
          code: "folio_collab_checkpoint_changed",
          status: 409,
        });
      } finally {
        store.stop();
      }
    },
  );
});
