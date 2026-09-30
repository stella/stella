import { expect, test } from "bun:test";

import { createFolioAIEditSnapshot } from "@stll/folio-core/ai-edits";
import { schema } from "@stll/folio-core/prosemirror";

import { withBlockTextHashes } from "./snapshot-blocks";

test("editable snapshots preserve text and hashes while excluding read-only carriers", () => {
  const snapshot = createFolioAIEditSnapshot(
    schema.node("doc", undefined, [
      schema.node("paragraph", { paraId: "A1" }, [
        schema.text("Keep these words"),
      ]),
    ]),
  );
  snapshot.blocks.push({
    id: "opaque",
    kind: "diagnostic",
    text: "Unsupported content",
    diagnostic: { type: "opaqueCarrier", carrier: "customXml" },
  });

  const blocks = withBlockTextHashes(snapshot);
  expect(blocks).toHaveLength(1);
  expect(blocks.at(0)).toMatchObject({
    id: "A1",
    kind: "paragraph",
    text: "Keep these words",
    blockTextHash: snapshot.anchors["A1"]?.textHash,
  });
});
