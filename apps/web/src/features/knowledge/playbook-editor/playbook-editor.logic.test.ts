import {
  onlineManager,
  QueryClient,
  QueryObserver,
  queryOptions,
} from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import type {
  DetailSeedGate,
  PlaybookDraft,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import {
  buildPlaybookSavePayload,
  createPlaybookBaseline,
  hasPlaybookDraftChanges,
  hasResolvedPositionSources,
  detailSeedGate,
  invalidPositionIds,
  latchedSeedGate,
  refetchSupersededDetail,
  resolveDetailSeed,
  resolvePlaybookScrollTop,
  resolvePositionSources,
  toPositionSourceLookup,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
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

describe("Seeding the editor from the cached detail", () => {
  type Detail = { name: string };
  const { queryKey: key } = queryOptions({
    queryKey: ["playbook", "detail"],
    queryFn: async (): Promise<Detail> => ({ name: "on the server" }),
  });

  // The cache as the list-to-editor round trip leaves it: the detail was read,
  // then a save invalidated it while no editor was observing it.
  const cacheAfterSave = async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(key, { name: "before save" });
    await queryClient.invalidateQueries({ queryKey: key });
    // Strictly later than the stale snapshot, as any real refetch is.
    await Bun.sleep(2);
    return queryClient;
  };

  const seedOf = (queryClient: QueryClient, gate: DetailSeedGate) => {
    const state = queryClient.getQueryState(key);
    if (state === undefined) {
      throw new TypeError("expected a cached detail");
    }
    return resolveDetailSeed({
      gate,
      dataUpdatedAt: state.dataUpdatedAt,
      fetchStatus: state.fetchStatus,
    });
  };

  const latchedAfterSeeding = (
    queryClient: QueryClient,
    gate: DetailSeedGate,
  ) => {
    const latched = latchedSeedGate(gate, seedOf(queryClient, gate));
    if (latched === null) {
      throw new TypeError("expected the stale seed to latch its gate");
    }
    return latched;
  };

  /** The refetch a mounting editor starts, answered by `queryFn`. */
  const refetchOnMount = async (
    queryClient: QueryClient,
    queryFn: () => Promise<Detail>,
  ) =>
    await queryClient
      .query({ queryKey: key, queryFn, retry: false, staleTime: 0 })
      .then(
        () => "landed" as const,
        () => "failed" as const,
      );

  test("a reopened editor waits for the refetch instead of seeding pre-save content", async () => {
    const queryClient = await cacheAfterSave();
    const gate = detailSeedGate(queryClient.getQueryState(key));
    const fresh = Promise.withResolvers<Detail>();

    const refetch = refetchOnMount(
      queryClient,
      async () => await fresh.promise,
    );
    expect(seedOf(queryClient, gate)).toEqual({ type: "wait" });

    fresh.resolve({ name: "after save" });
    expect(await refetch).toBe("landed");
    expect(queryClient.getQueryState(key)?.data).toEqual({
      name: "after save",
    });
    expect(seedOf(queryClient, gate)).toEqual({ type: "current" });
  });

  test("an editor opened on a detail nothing invalidated seeds at once", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(key, { name: "before save" });

    const gate = detailSeedGate(queryClient.getQueryState(key));

    expect(gate).toEqual({ type: "open" });
    expect(seedOf(queryClient, gate)).toEqual({ type: "current" });
  });

  test("a reopened editor whose refetch fails opens the cached detail as stale", async () => {
    const queryClient = await cacheAfterSave();
    const gate = detailSeedGate(queryClient.getQueryState(key));

    const refetch = refetchOnMount(queryClient, async () => {
      throw new Error("the API is down");
    });
    expect(seedOf(queryClient, gate)).toEqual({ type: "wait" });
    expect(await refetch).toBe("failed");

    expect(queryClient.getQueryState(key)?.status).toBe("error");
    expect(queryClient.getQueryState(key)?.data).toEqual({
      name: "before save",
    });
    expect(seedOf(queryClient, gate)).toEqual({
      type: "stale",
      fresher: "unavailable",
    });
  });

  test("a reopened editor whose refetch is paused opens the cached detail as stale", async () => {
    const queryClient = await cacheAfterSave();
    const gate = detailSeedGate(queryClient.getQueryState(key));
    // Mounted, as under the provider: the client resumes paused fetches when
    // the connection returns.
    queryClient.mount();
    onlineManager.setOnline(false);
    try {
      const refetch = refetchOnMount(queryClient, async () => ({
        name: "after save",
      }));
      await Bun.sleep(0);

      expect(queryClient.getQueryState(key)?.fetchStatus).toBe("paused");
      expect(seedOf(queryClient, gate)).toEqual({
        type: "stale",
        fresher: "unavailable",
      });

      // Back online the paused refetch lands. The form stays on the snapshot
      // it was seeded from (the gate is latched as stale) and is told a
      // fresher detail is in hand.
      const latched = latchedAfterSeeding(queryClient, gate);
      onlineManager.setOnline(true);
      expect(await refetch).toBe("landed");
      expect(seedOf(queryClient, latched)).toEqual({
        type: "stale",
        fresher: "loaded",
      });
    } finally {
      onlineManager.setOnline(true);
      queryClient.unmount();
    }
  });

  test("a stale-seeded form is not unmounted by a retry in flight", async () => {
    const queryClient = await cacheAfterSave();
    const gate = detailSeedGate(queryClient.getQueryState(key));
    // The refetch has failed or paused, and the form is seeded from the cache.
    const latched = latchedAfterSeeding(queryClient, gate);
    const fresh = Promise.withResolvers<Detail>();

    const refetch = refetchOnMount(
      queryClient,
      async () => await fresh.promise,
    );
    expect(seedOf(queryClient, gate)).toEqual({ type: "wait" });

    expect(seedOf(queryClient, latched)).toEqual({
      type: "stale",
      fresher: "loading",
    });
    fresh.resolve({ name: "after save" });
    await refetch;
  });

  test("a reload issued before the conflict refetch lands waits for it", async () => {
    // A mounted editor: the detail is observed, current, and not invalidated.
    const queryClient = new QueryClient();
    const fresh = Promise.withResolvers<Detail>();
    let serverDetail: Promise<Detail> = Promise.resolve({ name: "mine" });
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => await serverDetail,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      expect(detailSeedGate(queryClient.getQueryState(key))).toEqual({
        type: "open",
      });
      await Bun.sleep(2);

      // A rejected stale save: the editor refetches for the fresh token,
      // detached, and offers Reload.
      serverDetail = fresh.promise;
      const takeFreshToken = refetchSupersededDetail(queryClient, key);

      // Reload clicked while that refetch is still in flight.
      const gate = detailSeedGate(queryClient.getQueryState(key));
      expect(gate.type).toBe("awaiting");
      expect(queryClient.getQueryState(key)?.data).toEqual({ name: "mine" });
      expect(seedOf(queryClient, gate)).toEqual({ type: "wait" });

      fresh.resolve({ name: "theirs" });
      expect(await takeFreshToken).toEqual({ name: "theirs" });
      expect(seedOf(queryClient, gate)).toEqual({ type: "current" });
      expect(queryClient.getQueryState(key)?.data).toEqual({ name: "theirs" });
    } finally {
      unsubscribe();
    }
  });

  test("a conflict refetch that fails hands back no token", async () => {
    const queryClient = new QueryClient();
    let fails = false;
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => {
        if (fails) {
          throw new Error("the API is down");
        }
        return { name: "mine" };
      },
      retry: false,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      fails = true;

      expect(await refetchSupersededDetail(queryClient, key)).toBeNull();
      expect(detailSeedGate(queryClient.getQueryState(key)).type).toBe(
        "awaiting",
      );
    } finally {
      unsubscribe();
    }
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
    const withoutReadable = withoutPositionSource(graded, READABLE);
    expect(withoutReadable.sources).toEqual([UNRESOLVED]);
    expect(
      withoutPositionSource(withoutReadable, UNRESOLVED),
    ).not.toHaveProperty("sources");
    // Everything else about the position is untouched.
    const restored: Position = { ...withoutReadable, sources: SOURCES };
    expect(restored).toEqual(graded);
  });

  test("removing a source matches its matter as well as its document", () => {
    const sameDocumentElsewhere = {
      workspaceId: UNRESOLVED.workspaceId,
      entityId: READABLE.entityId,
    };
    const position: Position = {
      ...graded,
      sources: [sameDocumentElsewhere, READABLE],
    };
    expect(withoutPositionSource(position, READABLE).sources).toEqual([
      sameDocumentElsewhere,
    ]);
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

describe("An untouched blank position", () => {
  const filled: Position = { ...newExtractPosition(), issue: "Audit rights" };
  const draftWith = (positions: Position[]): PlaybookDraft => ({
    name: "DPA",
    description: "",
    documentTypeKey: null,
    perspective: null,
    trigger: null,
    positions,
  });

  test("is left out of the save, the dirty check and the validity check", () => {
    for (const blank of [newGradedPosition(), newExtractPosition()]) {
      const baseline = createPlaybookBaseline(draftWith([filled]));
      const withBlank = draftWith([filled, blank]);
      expect(buildPlaybookSavePayload(withBlank).positions.items).toHaveLength(
        1,
      );
      expect(hasPlaybookDraftChanges({ baseline, current: withBlank })).toBe(
        false,
      );
      expect(invalidPositionIds([filled, blank])).toEqual([]);
    }
  });

  test("joins the draft once typed in", () => {
    const typed: Position = { ...newExtractPosition(), issue: "T" };
    const baseline = createPlaybookBaseline(draftWith([filled]));
    expect(
      hasPlaybookDraftChanges({
        baseline,
        current: draftWith([filled, typed]),
      }),
    ).toBe(true);
    // A graded position with an issue but no standard still needs content.
    const graded: Position = { ...newGradedPosition(), issue: "Cap" };
    expect(invalidPositionIds([filled, graded])).toEqual([graded.sourceId]);
  });
});
