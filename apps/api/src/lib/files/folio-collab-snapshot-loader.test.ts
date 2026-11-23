import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as Y from "yjs";

import { serveCanonicalYjsRoom } from "@stll/folio-core/controller/canonicalYjsRoom";
import { extractDocxText, FolioDocxReviewer } from "@stll/folio-core/server";

import { toSafeId } from "@/api/lib/branded-types";
import { materializeRoomOverScannedDocx } from "@/api/lib/file-scan/document-parsers";
import {
  decideFolioSnapshotRecoveryState,
  FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME,
  loadPersistedFolioSnapshot,
} from "@/api/lib/files/folio-collab-snapshot-loader";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const savedVersionId = toSafeId<"entityVersion">("ev_saved");

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(
      new URL(`fixtures/folio-core-0.58.5/${name}`, import.meta.url),
    ),
  );

/** A room state from before rooms carried a canonical journal. */
const legacyRoomSnapshot = () => {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, "1");
  paragraph.insert(0, [text]);
  doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
};

/** A canonical room seeded from `docx` by its authority, with no edits yet. */
const seededRoomSnapshot = async (docx: Uint8Array) => {
  const { document, snapshot } = await FolioDocxReviewer.openRoomBase(
    docx.slice().buffer,
  );
  const doc = new Y.Doc();
  const authority = serveCanonicalYjsRoom({ doc, snapshot, document }).unwrap();
  authority.stop();
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
};

describe("persisted Folio collaboration snapshot loading", () => {
  test("invalid snapshot data returns a typed failure without resetting the room", async () => {
    let recoveryCalls = 0;
    const loaded = await loadPersistedFolioSnapshot({
      snapshotBytes: new Uint8Array([0xff]),
      onRefused: async () => {
        recoveryCalls += 1;
        return { status: "reset", generation: 4, resetGeneration: 3 };
      },
    });
    expect(Result.isError(loaded) && loaded.error.code).toBe("invalid_update");
    expect(recoveryCalls).toBe(0);
  });

  test("a legacy room state is discarded for DOCX rematerialization", async () => {
    const refusalCodes: string[] = [];
    const loaded = await loadPersistedFolioSnapshot({
      snapshotBytes: legacyRoomSnapshot(),
      onRefused: async (error) => {
        refusalCodes.push(error.code);
        return { status: "reset", generation: 4, resetGeneration: 3 };
      },
    });

    expect(refusalCodes).toEqual(["legacy_room"]);
    expect(loaded.unwrap()).toEqual({
      outcome: FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.rematerializeFromDocx,
      generation: 4,
      resetGeneration: 3,
      snapshotBytes: null,
    });
  });

  test.each(["clean.yjs", "dirty.yjs"])(
    "real 0.58.5 %s snapshots reopen from the saved DOCX",
    async (name) => {
      let resetCount = 0;
      const loaded = await loadPersistedFolioSnapshot({
        snapshotBytes: fixture(name),
        onRefused: async () => {
          resetCount += 1;
          return { status: "reset", generation: 4, resetGeneration: 3 };
        },
      });
      expect(loaded.unwrap()).toEqual({
        outcome: FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.rematerializeFromDocx,
        generation: 4,
        resetGeneration: 3,
        snapshotBytes: null,
      });
      expect(resetCount).toBe(1);
    },
  );

  test("a lost recovery CAS requests a reload instead of rematerialization", async () => {
    const loaded = await loadPersistedFolioSnapshot({
      snapshotBytes: legacyRoomSnapshot(),
      onRefused: async () => ({ status: "replaced" }),
    });
    expect(loaded.unwrap()).toEqual({ outcome: "reload-current" });
  });

  test("a canonical room loads byte for byte", async () => {
    const snapshot = await seededRoomSnapshot(fixture("saved.docx"));

    const loaded = await loadPersistedFolioSnapshot({
      snapshotBytes: snapshot,
      onRefused: async () => {
        throw new Error("Canonical rooms must not be refused.");
      },
    });

    expect(loaded.unwrap()).toEqual({
      outcome: FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.loaded,
      snapshotBytes: snapshot,
    });
  });
});

describe("room materialization", () => {
  test("a seeded room saves its DOCX, and refuses a DOCX it was not seeded from", async () => {
    const savedDocx = fixture("saved.docx");
    const yjsUpdate = await seededRoomSnapshot(savedDocx);
    const source = testScannedFile({
      bytes: savedDocx.slice().buffer,
      mimeType: DOCX_MIME_TYPE,
    });

    const materialized = (
      await materializeRoomOverScannedDocx({ source, yjsUpdate })
    ).unwrap();
    expect(
      (await extractDocxText(materialized)).paragraphs.map(({ text }) => text),
    ).toEqual(["Saved contract. Článek první."]);

    // Any other bytes name another snapshot.
    const otherDocx = new Uint8Array([...savedDocx, 0]);
    const refused = await materializeRoomOverScannedDocx({
      source: testScannedFile({
        bytes: otherDocx.buffer,
        mimeType: DOCX_MIME_TYPE,
      }),
      yjsUpdate,
    });
    expect(Result.isError(refused) ? refused.error : null).toMatchObject({
      reason: "snapshotMismatch",
    });
  });
});

describe("refused snapshot saved-cut decisions", () => {
  const savedHash = "a".repeat(64);
  const differentHash = "b".repeat(64);
  test.each([
    {
      name: "clean older historical snapshot",
      snapshotTime: 1,
      savedTime: 2,
      seedTime: null,
      expected: "saved",
    },
    {
      name: "historical initial seed older than its completed seed",
      snapshotTime: 1,
      savedTime: null,
      seedTime: 2,
      expected: "saved",
    },
    {
      name: "historical timestamp tie",
      snapshotTime: 2,
      savedTime: 2,
      seedTime: 2,
      expected: "unsaved",
    },
    {
      name: "newer historical snapshot",
      snapshotTime: 3,
      savedTime: 2,
      seedTime: 1,
      expected: "unsaved",
    },
    {
      name: "unknown snapshot time",
      snapshotTime: null,
      savedTime: 2,
      seedTime: 1,
      expected: "unsaved",
    },
    {
      name: "unknown historical baseline",
      snapshotTime: 1,
      savedTime: null,
      seedTime: null,
      expected: "unsaved",
    },
  ])("$name", ({ snapshotTime, savedTime, seedTime, expected }) => {
    expect(
      decideFolioSnapshotRecoveryState({
        savedSnapshotCut: null,
        savedVersionId,
        historicalBaseline: "initial-seed",
        snapshotSha256Hex: savedHash,
        snapshotUpdatedAt:
          snapshotTime === null ? null : new Date(snapshotTime),
        savedVersionCreatedAt: savedTime === null ? null : new Date(savedTime),
        seededAt: seedTime === null ? null : new Date(seedTime),
      }),
    ).toBe(expected);
  });

  test("exact saved bytes override timestamps, including identical-byte retransmissions", () => {
    for (const snapshotUpdatedAt of [null, new Date(1), new Date(3)]) {
      expect(
        decideFolioSnapshotRecoveryState({
          savedSnapshotCut: { versionId: savedVersionId, sha256Hex: savedHash },
          savedVersionId,
          historicalBaseline: "publication",
          snapshotSha256Hex: savedHash,
          snapshotUpdatedAt,
          savedVersionCreatedAt: new Date(2),
          seededAt: new Date(2),
        }),
      ).toBe("saved");
      expect(
        decideFolioSnapshotRecoveryState({
          savedSnapshotCut: { versionId: savedVersionId, sha256Hex: savedHash },
          savedVersionId,
          historicalBaseline: "publication",
          snapshotSha256Hex: differentHash,
          snapshotUpdatedAt,
          savedVersionCreatedAt: new Date(2),
          seededAt: new Date(2),
        }),
      ).toBe("unsaved");
    }
  });
});

test("an older historical snapshot after a publication has an unknown saved cut", () => {
  expect(
    decideFolioSnapshotRecoveryState({
      savedSnapshotCut: null,
      savedVersionId,
      snapshotSha256Hex: "a".repeat(64),
      snapshotUpdatedAt: new Date(1),
      savedVersionCreatedAt: new Date(3),
      seededAt: new Date(0),
      historicalBaseline: "publication",
    }),
  ).toBe("unsaved");
});

test("a saved hash bound to another version cannot mark the current snapshot clean", () => {
  expect(
    decideFolioSnapshotRecoveryState({
      savedSnapshotCut: {
        versionId: toSafeId<"entityVersion">("ev_previous"),
        sha256Hex: "a".repeat(64),
      },
      savedVersionId,
      snapshotSha256Hex: "a".repeat(64),
      snapshotUpdatedAt: new Date(1),
      savedVersionCreatedAt: new Date(3),
      seededAt: new Date(2),
      historicalBaseline: "initial-seed",
    }),
  ).toBe("unsaved");
});
