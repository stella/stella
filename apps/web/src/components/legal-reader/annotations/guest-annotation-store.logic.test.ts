import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { CreateAnnotationInput } from "@/components/legal-reader/annotations/annotation-types";
import {
  claimGuestAnnotations,
  createGuestAnnotation,
  deleteGuestAnnotation,
  EMPTY_GUEST_ANNOTATION_STORE,
  guestAnnotationRows,
  readGuestAnnotationStore,
  updateGuestAnnotation,
  uploadClaimedGuestAnnotations,
  writeGuestAnnotationStore,
} from "@/components/legal-reader/annotations/guest-annotation-store.logic";
import type {
  GuestAnnotation,
  GuestAnnotationClaimant,
  GuestAnnotationStore,
  GuestAnnotationTarget,
} from "@/components/legal-reader/annotations/guest-annotation-store.logic";
import { pruneUserStorage } from "@/lib/account/user-scoped-storage";
import type { StorageOwner } from "@/lib/account/user-scoped-storage";

const ids = [
  "019b0121-9dd7-7000-8000-000000000001",
  "019b0121-9dd7-7000-8000-000000000002",
];
const decision = {
  targetId: "019b0121-9dd7-7000-8000-000000000003",
  targetType: "decision",
} as const satisfies GuestAnnotationTarget;
const statute = {
  targetId: "019b0121-9dd7-7000-8000-000000000004",
  targetType: "statute",
} as const satisfies GuestAnnotationTarget;
const input = {
  color: "yellow",
  kind: "highlight",
  spans: [
    {
      blockAnchorId: "p-1",
      endOffset: 9,
      quote: "important",
      startOffset: 0,
    },
    {
      blockAnchorId: "p-2",
      endOffset: 8,
      quote: "language",
      startOffset: 0,
    },
  ],
  style: "highlight",
  visibility: "private",
} satisfies CreateAnnotationInput;

const memoryStorage = () => {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
};

const sequentialIds = () => {
  let index = 0;
  return () => ids.at(index++) ?? `019b0121-9dd7-7000-8000-00000000000${index}`;
};

describe("guest annotation store", () => {
  test("round-trips a bounded, versioned annotation and rebuilds its rows", () => {
    const store = createGuestAnnotation({
      input,
      newId: sequentialIds(),
      now: new Date("2026-09-09T12:00:00.000Z"),
      store: EMPTY_GUEST_ANNOTATION_STORE,
      target: statute,
    });
    const storage = memoryStorage();

    expect(Result.isOk(writeGuestAnnotationStore(storage, store))).toBe(true);
    const restored = readGuestAnnotationStore(storage);
    expect(restored).toEqual(store);
    expect(
      guestAnnotationRows({
        authorName: "You",
        store: restored,
        target: statute,
      }).map((row) => String(row.id)),
    ).toEqual(ids);
  });

  test("updates and deletes every row through the parent annotation", () => {
    const created = createGuestAnnotation({
      input,
      newId: sequentialIds(),
      now: new Date("2026-09-09T12:00:00.000Z"),
      store: EMPTY_GUEST_ANNOTATION_STORE,
      target: decision,
    });
    const updated = updateGuestAnnotation(created, {
      change: "color",
      color: "red",
      id: ids.at(1) ?? decision.targetId,
    });
    expect(updated.items.at(0)?.input).toMatchObject({ color: "red" });
    expect(
      deleteGuestAnnotation(updated, ids.at(1) ?? decision.targetId).items,
    ).toEqual([]);
  });

  test("rejects corrupted persisted data at the storage boundary", () => {
    const storage = memoryStorage();
    storage.setItem(
      "legal-reader-guest-annotations:v2",
      '{"version":2,"items":[{"targetId":"bad"}]}',
    );
    expect(readGuestAnnotationStore(storage)).toEqual(
      EMPTY_GUEST_ANNOTATION_STORE,
    );
  });

  test("reads the marks a tab was holding before statutes could be marked", () => {
    const storage = memoryStorage();
    storage.setItem(
      "case-law-guest-annotations:v1",
      JSON.stringify({
        items: [
          {
            createdAt: "2026-09-09T12:00:00.000Z",
            decisionId: decision.targetId,
            input,
            requestId: ids[0],
            rowIds: ids,
          },
        ],
        version: 1,
      }),
    );

    const migrated = readGuestAnnotationStore(storage);
    expect(migrated.version).toBe(2);
    expect(migrated.items.at(0)).toMatchObject({
      targetId: decision.targetId,
      targetType: "decision",
    });
    expect(
      guestAnnotationRows({
        authorName: "You",
        store: migrated,
        target: decision,
      }),
    ).toHaveLength(ids.length);

    // The migrated copy is the only one: a later write leaves nothing behind
    // that a cleared store could resurrect.
    expect(Result.isOk(writeGuestAnnotationStore(storage, migrated))).toBe(
      true,
    );
    expect(storage.entries.has("case-law-guest-annotations:v1")).toBe(false);
  });

  test("a mark is only ever read back on the document it was left on", () => {
    const targetArbitrary = fc.record({
      targetId: fc.uuid(),
      targetType: fc.constantFrom("decision" as const, "statute" as const),
    });

    assertProperty(
      "a mark is only ever read back on the document it was left on",
      fc.property(
        fc.uniqueArray(targetArbitrary, {
          minLength: 1,
          maxLength: 4,
          selector: (target) => `${target.targetType}:${target.targetId}`,
        }),
        fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 8 }),
        (targets, marks) => {
          let newIdCounter = 0;
          const newId = () =>
            `019b0121-9dd7-7000-8000-${String(newIdCounter++).padStart(12, "0")}`;
          const placed = marks.flatMap((pick) => {
            const target = targets.at(pick % targets.length);
            return target === undefined ? [] : [target];
          });
          let store = EMPTY_GUEST_ANNOTATION_STORE;
          for (const target of placed) {
            store = createGuestAnnotation({
              input,
              newId,
              now: new Date("2026-09-09T12:00:00.000Z"),
              store,
              target,
            });
          }

          for (const target of targets) {
            const expected = placed.filter(
              (item) =>
                item.targetId === target.targetId &&
                item.targetType === target.targetType,
            ).length;
            expect(
              guestAnnotationRows({ authorName: "You", store, target }),
            ).toHaveLength(expected * input.spans.length);
          }
          // Nothing is lost either: every mark is read back on some document.
          expect(store.items).toHaveLength(placed.length);
        },
      ),
      {},
    );
  });
});

describe("guest marks an account claims on sign-in", () => {
  const alice: GuestAnnotationClaimant = { kind: "user", userId: "alice" };
  const bob: GuestAnnotationClaimant = { kind: "user", userId: "bob" };
  const visitor: StorageOwner = { kind: "visitor" };
  const aliceClaimedKey = "legal-reader-claimed-annotations:v2:u:alice";

  /** A tab's session storage, as the sign-in and sign-out pruning walks it. */
  const tabStorage = (): Storage => {
    const entries = new Map<string, string>();
    return {
      get length() {
        return entries.size;
      },
      clear: () => {
        entries.clear();
      },
      getItem: (key) => entries.get(key) ?? null,
      key: (index) => [...entries.keys()].at(index) ?? null,
      removeItem: (key) => {
        entries.delete(key);
      },
      setItem: (key, value) => {
        entries.set(key, value);
      },
    };
  };

  const guestMarks = (count: number): GuestAnnotationStore => {
    let next = 0;
    const newId = () =>
      `019b0121-9dd7-7000-8000-${String(next++).padStart(12, "0")}`;
    let store = EMPTY_GUEST_ANNOTATION_STORE;
    for (let index = 0; index < count; index += 1) {
      store = createGuestAnnotation({
        input,
        newId,
        now: new Date("2026-09-09T12:00:00.000Z"),
        store,
        target: statute,
      });
    }
    return store;
  };

  const claim = (storage: Storage, owner: GuestAnnotationClaimant) => {
    const claimed = claimGuestAnnotations(storage, owner);
    if (Result.isError(claimed)) {
      throw claimed.error;
    }
    return claimed.value.items;
  };

  /** What waits for Alice; the tab holds no guest marks, so it only reads. */
  const keptForAlice = (storage: Storage) =>
    claim(storage, alice).map((item) => item.requestId);

  /**
   * A visitor leaves three marks and signs in as Alice, who signs out while
   * her first mark is still uploading.
   */
  const signOutMidUpload = async () => {
    const storage = tabStorage();
    const areas = { local: null, session: storage };
    const marks = guestMarks(3);
    expect(Result.isOk(writeGuestAnnotationStore(storage, marks))).toBe(true);
    let owner: StorageOwner = visitor;
    const signIn = (next: StorageOwner) => {
      pruneUserStorage(areas, owner, next);
      owner = next;
    };
    const uploads: string[] = [];
    const recordUpload = async (item: GuestAnnotation) => {
      uploads.push(item.requestId);
      return await Promise.resolve(Result.ok(undefined));
    };

    signIn(alice);
    const results = await uploadClaimedGuestAnnotations({
      isCurrentOwner: () => owner === alice,
      items: claim(storage, alice),
      limit: 1,
      owner: alice,
      storage,
      upload: async (item) => {
        signIn(visitor);
        return await recordUpload(item);
      },
    });
    expect(results.every((result) => Result.isOk(result))).toBe(true);
    const requestIds = marks.items.map((item) => item.requestId);
    return {
      owner: () => owner,
      recordUpload,
      requestIds,
      signIn,
      storage,
      uploads,
    };
  };

  test("a sign-out mid-upload keeps the marks not yet uploaded for that account", async () => {
    const { requestIds, storage, uploads } = await signOutMidUpload();

    expect(uploads).toEqual(requestIds.slice(0, 1));
    expect(keptForAlice(storage)).toEqual(requestIds.slice(1));
    // The visitor now in the tab does not see them as their own marks.
    expect(readGuestAnnotationStore(storage)).toEqual(
      EMPTY_GUEST_ANNOTATION_STORE,
    );
  });

  test("the same account's next sign-in uploads each kept mark exactly once", async () => {
    const { owner, recordUpload, requestIds, signIn, storage, uploads } =
      await signOutMidUpload();

    signIn(alice);
    const items = claim(storage, alice);
    await uploadClaimedGuestAnnotations({
      isCurrentOwner: () => owner() === alice,
      items,
      limit: 4,
      owner: alice,
      storage,
      upload: recordUpload,
    });

    expect(uploads).toHaveLength(requestIds.length);
    expect(new Set(uploads)).toEqual(new Set(requestIds));
    expect(storage.getItem(aliceClaimedKey)).toBeNull();
    expect(keptForAlice(storage)).toEqual([]);
  });

  test("another account's sign-in neither uploads nor sees the kept marks", async () => {
    const { owner, recordUpload, requestIds, signIn, storage, uploads } =
      await signOutMidUpload();

    signIn(bob);
    const items = claim(storage, bob);
    await uploadClaimedGuestAnnotations({
      isCurrentOwner: () => owner() === bob,
      items,
      limit: 4,
      owner: bob,
      storage,
      upload: recordUpload,
    });

    expect(items).toEqual([]);
    expect(uploads).toEqual(requestIds.slice(0, 1));
    expect(readGuestAnnotationStore(storage)).toEqual(
      EMPTY_GUEST_ANNOTATION_STORE,
    );
    // Still waiting for Alice, through Bob's session and his sign-out.
    signIn(visitor);
    expect(keptForAlice(storage)).toEqual(requestIds.slice(1));
  });
});
