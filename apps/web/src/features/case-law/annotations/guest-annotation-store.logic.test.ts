import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { CreateAnnotationInput } from "@/features/case-law/annotations/annotation-types";
import {
  createGuestAnnotation,
  deleteGuestAnnotation,
  EMPTY_GUEST_ANNOTATION_STORE,
  guestAnnotationRows,
  readGuestAnnotationStore,
  updateGuestAnnotation,
  writeGuestAnnotationStore,
} from "@/features/case-law/annotations/guest-annotation-store.logic";

const ids = [
  "019b0121-9dd7-7000-8000-000000000001",
  "019b0121-9dd7-7000-8000-000000000002",
];
const decisionId = "019b0121-9dd7-7000-8000-000000000003";
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

describe("guest annotation store", () => {
  test("round-trips a bounded, versioned annotation and rebuilds its rows", () => {
    let index = 0;
    const store = createGuestAnnotation({
      decisionId,
      input,
      newId: () => ids.at(index++) ?? "unreachable",
      now: new Date("2026-09-09T12:00:00.000Z"),
      store: EMPTY_GUEST_ANNOTATION_STORE,
    });
    let raw: string | null = null;
    const storage = {
      getItem: () => raw,
      removeItem: () => {
        raw = null;
      },
      setItem: (_key: string, value: string) => {
        raw = value;
      },
    };

    expect(Result.isOk(writeGuestAnnotationStore(storage, store))).toBe(true);
    const restored = readGuestAnnotationStore(storage);
    expect(restored).toEqual(store);
    expect(
      guestAnnotationRows({
        authorName: "You",
        decisionId,
        store: restored,
      }).map((row) => String(row.id)),
    ).toEqual(ids);
  });

  test("updates and deletes every row through the parent annotation", () => {
    let index = 0;
    const created = createGuestAnnotation({
      decisionId,
      input,
      newId: () => ids.at(index++) ?? "unreachable",
      now: new Date("2026-09-09T12:00:00.000Z"),
      store: EMPTY_GUEST_ANNOTATION_STORE,
    });
    const updated = updateGuestAnnotation(created, {
      change: "color",
      color: "red",
      id: ids.at(1) ?? decisionId,
    });
    expect(updated.items.at(0)?.input).toMatchObject({ color: "red" });
    expect(
      deleteGuestAnnotation(updated, ids.at(1) ?? decisionId).items,
    ).toEqual([]);
  });

  test("rejects corrupted persisted data at the storage boundary", () => {
    const storage = {
      getItem: () => '{"version":1,"items":[{"decisionId":"bad"}]}',
      removeItem: () => undefined,
      setItem: () => undefined,
    };
    expect(readGuestAnnotationStore(storage)).toEqual(
      EMPTY_GUEST_ANNOTATION_STORE,
    );
  });
});
