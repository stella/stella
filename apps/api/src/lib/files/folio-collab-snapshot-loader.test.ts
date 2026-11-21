import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as yProseMirror from "y-prosemirror";
import * as yjs from "yjs";

import { createHiddenEditorState } from "@stll/folio-core/controller/hiddenEditorManager";
import {
  extractDocxText,
  FOLIO_YJS_ATTR_SCHEMA_VERSION,
  materializeYjsDocx,
  migrateFolioYjsSnapshot,
  parseDocx,
} from "@stll/folio-core/server";

import { toSafeId } from "@/api/lib/branded-types";
import {
  decideFolioSnapshotRecoveryState,
  FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME,
  loadPersistedFolioSnapshot,
} from "@/api/lib/files/folio-collab-snapshot-loader";

const { Doc, XmlElement, XmlText, encodeStateAsUpdate } = yjs;

const savedVersionId = toSafeId<"entityVersion">("ev_saved");

const snapshotAtVersion = (version: number, unattributedReference = false) => {
  const doc = new Doc();
  doc.getMap("folio:document-metadata").set("attrSchemaVersion", version);
  const paragraph = new XmlElement("paragraph");
  const text = new XmlText();
  text.insert(
    0,
    "1",
    unattributedReference ? { footnoteRef: { id: 1 } } : undefined,
  );
  paragraph.insert(0, [text]);
  doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
  const update = encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
};

describe("persisted Folio collaboration snapshot loading", () => {
  test("invalid snapshot data returns a typed failure without resetting the room", async () => {
    let recoveryCalls = 0;
    const loaded = await loadPersistedFolioSnapshot({
      snapshotBytes: new Uint8Array(),
      onRefused: async () => {
        recoveryCalls += 1;
        return { status: "reset", generation: 4, resetGeneration: 3 };
      },
    });
    expect(Result.isError(loaded) && loaded.error.code).toBe("invalid_update");
    expect(
      Result.match(loaded, {
        ok: ({ outcome }) => outcome,
        err: ({ code }) => code,
      }),
    ).toBe("invalid_update");
    expect(recoveryCalls).toBe(0);
  });

  test("refused old-schema state is discarded for DOCX rematerialization", async () => {
    const refusedSnapshot = snapshotAtVersion(11, true);
    const refusalCodes: string[] = [];

    const loaded = await loadPersistedFolioSnapshot({
      snapshotBytes: refusedSnapshot,
      onRefused: async (error) => {
        refusalCodes.push(error.code);
        return { status: "reset", generation: 4, resetGeneration: 3 };
      },
    });

    expect(refusalCodes).toEqual(["unsupported_version"]);
    expect(loaded.unwrap()).toEqual({
      outcome: FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.rematerializeFromDocx,
      generation: 4,
      resetGeneration: 3,
      snapshotBytes: null,
    });
  });

  test.each(["clean", "dirty"])(
    "real 0.58.5 %s snapshots reopen from the saved DOCX after schema refusal",
    async (state) => {
      const snapshotBytes = new Uint8Array(
        readFileSync(
          new URL(`fixtures/folio-core-0.58.5/${state}.yjs`, import.meta.url),
        ),
      );
      const refusal = migrateFolioYjsSnapshot(snapshotBytes);
      expect(FOLIO_YJS_ATTR_SCHEMA_VERSION).toBe(14);
      expect(Result.isError(refusal) && refusal.error.code).toBe(
        "unsupported_version",
      );

      let resetCount = 0;
      const loaded = await loadPersistedFolioSnapshot({
        snapshotBytes,
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

      // Reopening seeds from the saved package, never from refused CRDT content.
      const savedDocx = new Uint8Array(
        readFileSync(
          new URL("fixtures/folio-core-0.58.5/saved.docx", import.meta.url),
        ),
      );
      const reopened = await parseDocx(savedDocx);
      const reseeded = new Doc();
      const editorState = createHiddenEditorState({
        document: reopened,
        collaboration: {
          shouldSeed: true,
          yXmlFragment: reseeded.getXmlFragment("prosemirror"),
        },
        collaborationModules: { yjs, yProseMirror },
      });
      expect(editorState.doc.textContent).toBe("Saved contract. Článek první.");
      const materialized = await materializeYjsDocx({
        sourceDocx: savedDocx,
        yjsUpdate: encodeStateAsUpdate(reseeded),
      });
      reseeded.destroy();
      expect(await extractDocxText(materialized)).toEqual(
        await extractDocxText(savedDocx),
      );
      expect(
        (await extractDocxText(materialized)).paragraphs.map(
          ({ text }) => text,
        ),
      ).toEqual(["Saved contract. Článek první."]);
    },
  );

  test("a lost recovery CAS requests a reload instead of rematerialization", async () => {
    const loaded = await loadPersistedFolioSnapshot({
      snapshotBytes: snapshotAtVersion(11, true),
      onRefused: async () => ({ status: "replaced" }),
    });
    expect(loaded.unwrap()).toEqual({ outcome: "reload-current" });
  });

  test("a current snapshot loads byte for byte", async () => {
    const snapshot = snapshotAtVersion(FOLIO_YJS_ATTR_SCHEMA_VERSION);

    const loaded = await loadPersistedFolioSnapshot({
      snapshotBytes: snapshot,
      onRefused: async () => {
        throw new Error("Current snapshots must not be refused.");
      },
    });

    expect(loaded.unwrap()).toEqual({
      outcome: FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.loaded,
      snapshotBytes: snapshot,
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
