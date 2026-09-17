import { describe, expect, test } from "bun:test";

import { DOCUMENT_PANE } from "@/components/inspector/document-pane";

import {
  claimDocxEditorSlot,
  DOCX_EDITOR_RELEASE_GRACE_MS,
  DOCX_EDITOR_SLOT,
  DOCX_EDITOR_SLOT_BY_PANE,
  docxEditorHostKey,
  docxEditorSlotForPane,
  EMPTY_DOCX_EDITOR_REGISTRY,
  isDocxEditorHostClaimed,
  nextDocxEditorSweepAt,
  releaseDocxEditorSlot,
  selectActiveDocxEditorClaim,
  sweepDocxEditorRegistry,
} from "./docx-editor-host.logic";
import type { DocxEditorClaim } from "./docx-editor-host.logic";

const document = {
  workspaceId: "matter-1",
  entityId: "entity-1",
  fileFieldId: "field-1",
  propertyId: "property-1",
};

const hostKey = docxEditorHostKey(document);

const bindings = { onClose: () => undefined };

const mainClaim = (sequence: number): DocxEditorClaim => ({
  bindings,
  canUnlock: true,
  document,
  isEditing: false,
  scaleOffset: undefined,
  sequence,
  slot: DOCX_EDITOR_SLOT.main,
  surface: "fullView",
});

const inspectorClaim = (sequence: number): DocxEditorClaim => ({
  bindings,
  canUnlock: true,
  document,
  initialScrollTop: 420,
  isEditing: false,
  scaleOffset: undefined,
  sequence,
  slot: DOCX_EDITOR_SLOT.inspector,
  surface: "inspector",
});

describe("hosted DOCX editor: pane vocabulary", () => {
  test("every arrangement names the slot its document is read in", () => {
    expect(DOCX_EDITOR_SLOT_BY_PANE).toEqual({
      document: DOCX_EDITOR_SLOT.main,
      review: DOCX_EDITOR_SLOT.inspector,
      margin: DOCX_EDITOR_SLOT.main,
    });
  });

  test("only the review arrangement reads the document in the inspector", () => {
    expect(docxEditorSlotForPane(DOCUMENT_PANE.document)).toBe(
      DOCX_EDITOR_SLOT.main,
    );
    expect(docxEditorSlotForPane(DOCUMENT_PANE.margin)).toBe(
      DOCX_EDITOR_SLOT.main,
    );
    expect(docxEditorSlotForPane(DOCUMENT_PANE.review)).toBe(
      DOCX_EDITOR_SLOT.inspector,
    );
  });

  test("one instance per document field, whichever slot shows it", () => {
    expect(hostKey).toBe("matter-1:entity-1:field-1");
    expect(docxEditorHostKey({ ...document, fileFieldId: "field-2" })).not.toBe(
      hostKey,
    );
  });
});

describe("hosted DOCX editor: claiming", () => {
  test("a claim opens the entry and drives the instance", () => {
    const registry = claimDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
      claim: mainClaim(1),
      hostKey,
    });

    expect(selectActiveDocxEditorClaim(registry[hostKey])).toEqual(
      mainClaim(1),
    );
    expect(registry[hostKey]?.releasedAt).toBeNull();
  });

  test("re-claiming a slot replaces that slot's claim, never duplicates it", () => {
    const registry = claimDocxEditorSlot(
      claimDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
        claim: mainClaim(1),
        hostKey,
      }),
      { claim: mainClaim(2), hostKey },
    );

    expect(registry[hostKey]?.claims).toHaveLength(1);
    expect(selectActiveDocxEditorClaim(registry[hostKey])?.sequence).toBe(2);
  });

  test("while both slots claim, the newer one drives the instance", () => {
    const mainFirst = claimDocxEditorSlot(
      claimDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
        claim: mainClaim(1),
        hostKey,
      }),
      { claim: inspectorClaim(2), hostKey },
    );
    expect(selectActiveDocxEditorClaim(mainFirst[hostKey])?.slot).toBe(
      DOCX_EDITOR_SLOT.inspector,
    );

    // The swap commits in the other order just as often: the arriving slot
    // still wins, so the editor never lands in the pane it just left.
    const inspectorFirst = claimDocxEditorSlot(
      claimDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
        claim: inspectorClaim(1),
        hostKey,
      }),
      { claim: mainClaim(2), hostKey },
    );
    expect(selectActiveDocxEditorClaim(inspectorFirst[hostKey])?.slot).toBe(
      DOCX_EDITOR_SLOT.main,
    );
  });

  test("a document nothing has ever claimed has no instance", () => {
    expect(selectActiveDocxEditorClaim(undefined)).toBeNull();
  });
});

describe("hosted DOCX editor: releasing", () => {
  test("releasing one of two slots leaves the other driving, with no grace", () => {
    const claimed = claimDocxEditorSlot(
      claimDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
        claim: mainClaim(1),
        hostKey,
      }),
      { claim: inspectorClaim(2), hostKey },
    );
    const released = releaseDocxEditorSlot(claimed, {
      hostKey,
      now: 1000,
      sequence: 1,
      slot: DOCX_EDITOR_SLOT.main,
    });

    expect(released[hostKey]?.releasedAt).toBeNull();
    expect(selectActiveDocxEditorClaim(released[hostKey])?.slot).toBe(
      DOCX_EDITOR_SLOT.inspector,
    );
  });

  test("a stale teardown cannot take the same slot's newer claim with it", () => {
    const reclaimed = claimDocxEditorSlot(
      claimDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
        claim: mainClaim(1),
        hostKey,
      }),
      { claim: mainClaim(2), hostKey },
    );
    const released = releaseDocxEditorSlot(reclaimed, {
      hostKey,
      now: 1000,
      sequence: 1,
      slot: DOCX_EDITOR_SLOT.main,
    });

    expect(selectActiveDocxEditorClaim(released[hostKey])?.sequence).toBe(2);
    expect(released[hostKey]?.releasedAt).toBeNull();
  });

  test("releasing the last claim starts the grace window, not a teardown", () => {
    const claimed = claimDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
      claim: mainClaim(1),
      hostKey,
    });
    const released = releaseDocxEditorSlot(claimed, {
      hostKey,
      now: 1000,
      sequence: 1,
      slot: DOCX_EDITOR_SLOT.main,
    });

    expect(released[hostKey]).toBeDefined();
    expect(released[hostKey]?.releasedAt).toBe(1000);
    expect(isDocxEditorHostClaimed(released[hostKey])).toBe(false);
    // Still driven by the claim it was last shown under, so the editor keeps
    // rendering while the swap's other half mounts.
    expect(selectActiveDocxEditorClaim(released[hostKey])).toEqual(
      mainClaim(1),
    );
  });

  test("releasing an unknown entry changes nothing", () => {
    expect(
      releaseDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
        hostKey,
        now: 1,
        sequence: 1,
        slot: DOCX_EDITOR_SLOT.main,
      }),
    ).toBe(EMPTY_DOCX_EDITOR_REGISTRY);
  });
});

describe("hosted DOCX editor: the grace window", () => {
  const released = releaseDocxEditorSlot(
    claimDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
      claim: mainClaim(1),
      hostKey,
    }),
    { hostKey, now: 1000, sequence: 1, slot: DOCX_EDITOR_SLOT.main },
  );

  test("the swap's other half claims inside the window and keeps the instance", () => {
    const reclaimed = claimDocxEditorSlot(released, {
      claim: inspectorClaim(2),
      hostKey,
    });

    expect(reclaimed[hostKey]?.releasedAt).toBeNull();
    expect(
      sweepDocxEditorRegistry(reclaimed, {
        graceMs: DOCX_EDITOR_RELEASE_GRACE_MS,
        now: 1000 + DOCX_EDITOR_RELEASE_GRACE_MS + 1,
      })[hostKey],
    ).toBeDefined();
  });

  test("an instance survives right up to its deadline and not past it", () => {
    const graceMs = DOCX_EDITOR_RELEASE_GRACE_MS;
    expect(
      sweepDocxEditorRegistry(released, { graceMs, now: 1000 + graceMs - 1 })[
        hostKey
      ],
    ).toBeDefined();
    expect(
      sweepDocxEditorRegistry(released, { graceMs, now: 1000 + graceMs })[
        hostKey
      ],
    ).toBeUndefined();
  });

  test("a sweep that drops nothing returns the same registry", () => {
    expect(sweepDocxEditorRegistry(released, { graceMs: 5, now: 1001 })).toBe(
      released,
    );
  });

  test("the sweep is scheduled for the earliest deadline, and only for released entries", () => {
    expect(nextDocxEditorSweepAt(released, 500)).toBe(1500);

    const otherKey = docxEditorHostKey({ ...document, fileFieldId: "field-2" });
    const withLive = claimDocxEditorSlot(released, {
      claim: mainClaim(3),
      hostKey: otherKey,
    });
    expect(nextDocxEditorSweepAt(withLive, 500)).toBe(1500);

    const earlier = releaseDocxEditorSlot(withLive, {
      hostKey: otherKey,
      now: 200,
      sequence: 3,
      slot: DOCX_EDITOR_SLOT.main,
    });
    expect(nextDocxEditorSweepAt(earlier, 500)).toBe(700);
  });

  test("nothing released means no timer", () => {
    expect(
      nextDocxEditorSweepAt(
        claimDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
          claim: mainClaim(1),
          hostKey,
        }),
        500,
      ),
    ).toBeNull();
  });
});
