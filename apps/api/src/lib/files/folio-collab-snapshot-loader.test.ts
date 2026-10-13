import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { Doc, XmlElement, XmlText, encodeStateAsUpdate } from "yjs";

import { FOLIO_YJS_ATTR_SCHEMA_VERSION } from "@stll/folio-core/server";

import {
  FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME,
  loadPersistedFolioSnapshot,
} from "@/api/lib/files/folio-collab-snapshot-loader";

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
