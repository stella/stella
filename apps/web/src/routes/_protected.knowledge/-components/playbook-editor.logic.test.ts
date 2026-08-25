import { describe, expect, test } from "bun:test";

import { newExtractPosition } from "@/lib/knowledge/playbook-types";
import type { PlaybookDraft } from "@/routes/_protected.knowledge/-components/playbook-editor.logic";
import {
  buildPlaybookSavePayload,
  createPlaybookBaseline,
  hasPlaybookDraftChanges,
  resolvePlaybookScrollTop,
} from "@/routes/_protected.knowledge/-components/playbook-editor.logic";

describe("Playbook outline navigation", () => {
  test("calculates a pane-local target without moving ancestor scroll containers", () => {
    expect(
      resolvePlaybookScrollTop({
        containerScrollTop: 320,
        containerTop: 64,
        targetTop: 464,
        topOffset: 24,
      }),
    ).toBe(696);
  });

  test("does not scroll before the start of the Playbook pane", () => {
    expect(
      resolvePlaybookScrollTop({
        containerScrollTop: 10,
        containerTop: 64,
        targetTop: 40,
        topOffset: 24,
      }),
    ).toBe(0);
  });
});

describe("Playbook draft state", () => {
  const position = newExtractPosition();
  const persisted: PlaybookDraft = {
    name: "NDA review",
    description: "Review the mutual NDA",
    documentTypeKey: "nda",
    perspective: "buyer",
    trigger: "manual",
    positions: [position],
  };
  const baseline = createPlaybookBaseline(persisted);

  // One mutation per savable draft field, keyed by the field it touches. The
  // map is total over `PlaybookDraft`, so a new savable field fails to
  // typecheck until it is given a mutation here — which is what stops a field
  // from silently escaping dirty tracking.
  const DRAFT_MUTATIONS = {
    name: (draft: PlaybookDraft) => ({ ...draft, name: "DPA review" }),
    description: (draft: PlaybookDraft) => ({
      ...draft,
      description: "Review the processor terms",
    }),
    documentTypeKey: (draft: PlaybookDraft) => ({
      ...draft,
      documentTypeKey: "dpa",
    }),
    perspective: (draft: PlaybookDraft) => ({
      ...draft,
      perspective: "seller",
    }),
    trigger: (draft: PlaybookDraft) => ({ ...draft, trigger: "onClassified" }),
    positions: (draft: PlaybookDraft) => ({
      ...draft,
      positions: [{ ...position, issue: "Governing law" }],
    }),
  } satisfies Record<
    keyof PlaybookDraft,
    (draft: PlaybookDraft) => PlaybookDraft
  >;

  test("treats the persisted draft as clean", () => {
    expect(hasPlaybookDraftChanges({ baseline, current: persisted })).toBe(
      false,
    );
    // Same values, fresh objects: the fast path misses and the fingerprint
    // has to settle it.
    expect(
      hasPlaybookDraftChanges({
        baseline,
        current: { ...persisted, positions: [...persisted.positions] },
      }),
    ).toBe(false);
  });

  test("detects a change to every field the save payload carries", () => {
    for (const [field, mutate] of Object.entries(DRAFT_MUTATIONS)) {
      expect({
        field,
        dirty: hasPlaybookDraftChanges({
          baseline,
          current: mutate(persisted),
        }),
      }).toEqual({ field, dirty: true });
    }
  });

  test("ignores whitespace that the save boundary normalizes", () => {
    expect(
      hasPlaybookDraftChanges({
        baseline,
        current: {
          ...persisted,
          name: ` ${persisted.name} `,
          description: ` ${persisted.description} `,
          positions: [{ ...position, issue: "  " }],
        },
      }),
    ).toBe(false);
  });
});

describe("Playbook save payload", () => {
  const base: PlaybookDraft = {
    name: "  NDA review  ",
    description: "   ",
    documentTypeKey: null,
    perspective: null,
    trigger: null,
    positions: [],
  };

  test("omits the scope entirely when every facet is at its default", () => {
    const payload = buildPlaybookSavePayload(base);
    expect(payload).toEqual({
      name: "NDA review",
      positions: { version: 3, items: [] },
    });
    expect(Object.hasOwn(payload, "scope")).toBe(false);
    expect(Object.hasOwn(payload, "description")).toBe(false);
  });

  test("carries perspective and trigger whenever a scope is sent", () => {
    expect(
      buildPlaybookSavePayload({
        ...base,
        documentTypeKey: "nda",
        perspective: "seller",
        trigger: "onClassified",
      }).scope,
    ).toEqual({
      documentTypeKey: "nda",
      perspective: "seller",
      trigger: "onClassified",
    });
  });

  test("sends an explicit trigger even when only the perspective is set", () => {
    expect(buildPlaybookSavePayload({ ...base, perspective: "buyer" })).toEqual(
      {
        name: "NDA review",
        scope: { perspective: "buyer", trigger: "manual" },
        positions: { version: 3, items: [] },
      },
    );
  });
});
