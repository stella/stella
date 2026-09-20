import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

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
  selectMountedDocxEditorClaim,
  sweepDocxEditorRegistry,
} from "./docx-editor-host.logic";
import type {
  DocxEditorClaim,
  DocxEditorSlotName,
} from "./docx-editor-host.logic";

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

const claimFor = (
  slot: DocxEditorSlotName,
  sequence: number,
): DocxEditorClaim =>
  slot === DOCX_EDITOR_SLOT.main
    ? mainClaim(sequence)
    : inspectorClaim(sequence);

const bothSlotsClaimed = claimDocxEditorSlot(
  claimDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
    claim: mainClaim(1),
    hostKey,
  }),
  { claim: inspectorClaim(2), hostKey },
);

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

  test("releasing the newer of two slots hands the instance to the older one", () => {
    const released = releaseDocxEditorSlot(bothSlotsClaimed, {
      hostKey,
      now: 1000,
      sequence: 2,
      slot: DOCX_EDITOR_SLOT.inspector,
    });

    expect(released[hostKey]?.claims).toEqual([mainClaim(1)]);
    expect(selectActiveDocxEditorClaim(released[hostKey])).toEqual(
      mainClaim(1),
    );
    // A slot still holds the instance, so there is no grace window to sweep:
    // the departed slot must not keep the entry pointed at a gone target.
    expect(released[hostKey]?.releasedAt).toBeNull();
    expect(
      nextDocxEditorSweepAt(released, DOCX_EDITOR_RELEASE_GRACE_MS),
    ).toBeNull();
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

describe("hosted DOCX editor: which slot shows the instance", () => {
  test("a claim whose slot has not mounted its target leaves the editor in the mounted one", () => {
    expect(
      selectMountedDocxEditorClaim(
        bothSlotsClaimed[hostKey],
        (slot) => slot === DOCX_EDITOR_SLOT.main,
      ),
    ).toEqual(mainClaim(1));
  });

  test("the newest slot that has mounted its target takes the instance", () => {
    expect(
      selectMountedDocxEditorClaim(bothSlotsClaimed[hostKey], () => true),
    ).toEqual(inspectorClaim(2));
  });

  test("with no slot mounted the instance keeps rendering rather than being dropped", () => {
    const graced = releaseDocxEditorSlot(
      claimDocxEditorSlot(EMPTY_DOCX_EDITOR_REGISTRY, {
        claim: mainClaim(1),
        hostKey,
      }),
      { hostKey, now: 1000, sequence: 1, slot: DOCX_EDITOR_SLOT.main },
    );

    expect(selectMountedDocxEditorClaim(graced[hostKey], () => false)).toEqual(
      mainClaim(1),
    );
  });
});

const slotOperations = fc.array(
  fc.record({
    kind: fc.constantFrom("claim", "release"),
    slot: fc.constantFrom(DOCX_EDITOR_SLOT.main, DOCX_EDITOR_SLOT.inspector),
    /** Whether the teardown names a sequence the slot no longer holds, which
     *  is what a fast remount inside one slot produces. */
    stale: fc.boolean(),
  }),
  { maxLength: 24, minLength: 1 },
);

describe("hosted DOCX editor: any order of claims and releases", () => {
  test("a slot that still holds a claim always drives the instance", () => {
    fc.assert(
      fc.property(slotOperations, (operations) => {
        let registry = EMPTY_DOCX_EDITOR_REGISTRY;
        let sequence = 0;
        const held = new Map<DocxEditorSlotName, number>();

        for (const [step, operation] of operations.entries()) {
          if (operation.kind === "claim") {
            sequence += 1;
            held.set(operation.slot, sequence);
            registry = claimDocxEditorSlot(registry, {
              claim: claimFor(operation.slot, sequence),
              hostKey,
            });
          } else {
            const registered = held.get(operation.slot);
            const releasing =
              operation.stale || registered === undefined
                ? sequence + 1
                : registered;
            if (releasing === registered) {
              held.delete(operation.slot);
            }
            registry = releaseDocxEditorSlot(registry, {
              hostKey,
              now: step,
              sequence: releasing,
              slot: operation.slot,
            });
          }

          const entry = registry[hostKey];
          if (entry === undefined) {
            continue;
          }
          const active = selectActiveDocxEditorClaim(entry);
          expect(entry.releasedAt === null).toBe(entry.claims.length > 0);

          if (entry.claims.length === 0) {
            // Nothing holds the instance: it keeps the claim it was last shown
            // under, so the grace window still has something to render.
            expect(active).not.toBeNull();
            continue;
          }
          // The claim driving the instance is one of the live ones, by
          // identity, and the newest of them.
          expect(entry.claims.some((claim) => claim === active)).toBe(true);
          expect(active?.sequence).toBe(
            Math.max(...entry.claims.map((claim) => claim.sequence)),
          );
        }
      }),
      propertyConfig(),
    );
  });
});
