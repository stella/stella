import { describe, expect, test } from "bun:test";

import {
  duplicatePosition,
  extractToGraded,
  gradedToExtract,
  newExtractPosition,
  newGradedPosition,
  normalizePosition,
  withoutPositionSource,
} from "@/lib/knowledge/playbook-types";
import type {
  ExtractPosition,
  GradedPosition,
  Position,
} from "@/lib/knowledge/playbook-types";
import { toSafeId } from "@/lib/safe-id";
import type { PlaybookDraft } from "@/routes/knowledge/-components/playbook-editor.logic";
import {
  buildPlaybookSavePayload,
  createPlaybookBaseline,
  hasPlaybookDraftChanges,
  hasResolvedPositionSources,
  resolvePlaybookScrollTop,
  resolvePositionSources,
  toPositionSourceLookup,
} from "@/routes/knowledge/-components/playbook-editor.logic";

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

describe("Playbook position sources", () => {
  const READABLE = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    entityId: "22222222-2222-4222-8222-222222222222",
  };
  // Stored on the position, absent from the reader's overlay: a document in a
  // matter this reader cannot open.
  const UNRESOLVED = {
    workspaceId: "33333333-3333-4333-8333-333333333333",
    entityId: "44444444-4444-4444-8444-444444444444",
  };
  const SOURCES = [UNRESOLVED, READABLE];
  const lookup = toPositionSourceLookup([
    {
      workspaceId: toSafeId<"workspace">(READABLE.workspaceId),
      entityId: toSafeId<"entity">(READABLE.entityId),
      name: "Supply agreement.docx",
      workspaceName: "Supply",
    },
  ]);

  const extract: ExtractPosition = {
    ...newExtractPosition(),
    issue: "Governing law",
    guidance: "Check the venue too",
    sources: SOURCES,
  };
  const graded: GradedPosition = {
    ...newGradedPosition(),
    issue: "Liability cap",
    guidance: "Compare against fees",
    sources: SOURCES,
    standard: {
      source: "tiers",
      tiers: {
        acceptable: {
          rules: [{ id: "55555555-5555-4555-8555-555555555555", text: "Cap" }],
        },
        fallback: { entries: [] },
        notAcceptable: { rules: [] },
      },
    },
  };

  test("lists only the sources the reader can open, with no trace of the rest", () => {
    const resolved = resolvePositionSources(graded, lookup);
    expect(resolved.map((source) => source.name)).toEqual([
      "Supply agreement.docx",
    ]);
    expect(resolvePositionSources(graded, new Map())).toEqual([]);
  });

  // The regression this guards: the editor saves a full replace, so a source
  // the reader cannot resolve must still be in the body, or opening and saving
  // a playbook would delete provenance its editor never saw.
  test("a loaded playbook saves every stored source back, resolved or not", () => {
    const payload = buildPlaybookSavePayload({
      name: "NDA review",
      description: "",
      documentTypeKey: null,
      perspective: null,
      trigger: null,
      positions: [extract, graded],
    });
    expect(payload.positions.items.map((item) => item.sources)).toEqual([
      SOURCES,
      SOURCES,
    ]);
  });

  test.each<[string, (position: Position) => Position]>([
    ["normalizing for save", normalizePosition],
    ["duplicating", duplicatePosition],
    [
      "converting the mode",
      (position) =>
        position.mode === "graded"
          ? gradedToExtract(position)
          : extractToGraded(position),
    ],
    [
      "converting the mode and back",
      (position) =>
        position.mode === "graded"
          ? extractToGraded(gradedToExtract(position))
          : gradedToExtract(extractToGraded(position)),
    ],
  ])("%s keeps a position's sources", (_label, transform) => {
    for (const position of [extract, graded]) {
      expect(transform(position).sources).toEqual(SOURCES);
    }
  });

  test("removing a visible source leaves the unresolved one, and the last removal drops the key", () => {
    const withoutReadable = withoutPositionSource(graded, READABLE.entityId);
    expect(withoutReadable.sources).toEqual([UNRESOLVED]);
    expect(
      withoutPositionSource(withoutReadable, UNRESOLVED.entityId),
    ).not.toHaveProperty("sources");
    // Everything else about the position is untouched.
    const restored: Position = { ...withoutReadable, sources: SOURCES };
    expect(restored).toEqual(graded);
  });

  test("only a source the reader can open counts toward the approval notice", () => {
    const citing = (sources: typeof SOURCES): Position => ({
      ...newExtractPosition(),
      sources,
    });
    expect(hasResolvedPositionSources([newExtractPosition()], lookup)).toBe(
      false,
    );
    // A source this reader cannot resolve must not surface as a notice.
    expect(hasResolvedPositionSources([citing([UNRESOLVED])], lookup)).toBe(
      false,
    );
    expect(
      hasResolvedPositionSources(
        [newExtractPosition(), citing([UNRESOLVED, READABLE])],
        lookup,
      ),
    ).toBe(true);
  });
});
