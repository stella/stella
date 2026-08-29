import { describe, expect, test } from "bun:test";
import { Doc, encodeStateVector } from "yjs";

import { advanceFolioCollaborationMutationRevision } from "./folio-collaboration-mutations";

describe("collaboration mutation revisions", () => {
  test("advances the local revision for a deletion even when the Yjs state vector does not", () => {
    const document = new Doc();
    const text = document.getText("body");
    text.insert(0, "remove me");
    const vectorBeforeDelete = encodeStateVector(document);

    text.delete(0, text.length);
    const vectorAfterDelete = encodeStateVector(document);
    const revision = advanceFolioCollaborationMutationRevision({
      current: { document: 1, local: 1 },
      hasChanges: true,
      local: true,
    });

    expect(vectorAfterDelete).toEqual(vectorBeforeDelete);
    expect(revision).toEqual({ document: 2, local: 2 });
    document.destroy();
  });

  test("advances only the document revision for a remote change", () => {
    expect(
      advanceFolioCollaborationMutationRevision({
        current: { document: 4, local: 2 },
        hasChanges: true,
        local: false,
      }),
    ).toEqual({ document: 5, local: 2 });
  });
});
