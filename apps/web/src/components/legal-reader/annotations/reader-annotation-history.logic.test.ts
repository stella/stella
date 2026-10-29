import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type {
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";
import {
  createGuestAnnotation,
  deleteGuestAnnotation,
  EMPTY_GUEST_ANNOTATION_STORE,
  guestAnnotationRows,
  updateGuestAnnotation,
} from "@/components/legal-reader/annotations/guest-annotation-store.logic";
import type {
  GuestAnnotationStore,
  GuestAnnotationTarget,
} from "@/components/legal-reader/annotations/guest-annotation-store.logic";
import {
  EMPTY_READER_ANNOTATION_HISTORY,
  inverseOfCreate,
  inverseOfRemove,
  inverseOfUpdate,
  performReaderAnnotationStep,
  planReaderAnnotationStep,
  READER_ANNOTATION_HISTORY_LIMIT,
  readerAnnotationStepOutcome,
  recordReaderAnnotationStep,
  remapReaderAnnotationRows,
  settleReaderAnnotationStep,
  takeReaderAnnotationStep,
} from "@/components/legal-reader/annotations/reader-annotation-history.logic";
import type {
  ReaderAnnotationHistory,
  ReaderAnnotationHistoryDirection,
  ReaderAnnotationInverse,
  ReaderAnnotationWrites,
} from "@/components/legal-reader/annotations/reader-annotation-history.logic";

const target = {
  targetId: "019b0121-9dd7-7000-8000-0000000000aa",
  targetType: "decision",
} as const satisfies GuestAnnotationTarget;

const highlight = {
  color: "yellow",
  kind: "highlight",
  spans: [
    { blockAnchorId: "p-1", endOffset: 9, quote: "important", startOffset: 0 },
    { blockAnchorId: "p-2", endOffset: 8, quote: "language", startOffset: 0 },
  ],
  style: "highlight",
  visibility: "private",
} satisfies CreateAnnotationInput;

const comment = {
  body: "Compare with the appellate reasoning.",
  kind: "comment",
  spans: [
    {
      blockAnchorId: "p-3",
      endOffset: 12,
      quote: "the contract",
      startOffset: 0,
    },
    { blockAnchorId: "p-4", endOffset: 6, quote: "lapsed", startOffset: 0 },
  ],
  visibility: "shared",
} satisfies CreateAnnotationInput;

/**
 * The tab store the guest reader writes to, used as the real engine: rows,
 * groups and ids come from the same code that lays them out in the app.
 */
const tabStore = () => {
  let store: GuestAnnotationStore = EMPTY_GUEST_ANNOTATION_STORE;
  let next = 0;
  const failing = new Set<"create" | "remove" | "update">();
  const newId = () => {
    next += 1;
    return `019b0121-9dd7-7000-8000-${String(next).padStart(12, "0")}`;
  };
  const refused = () => Result.err(new Error("refused"));
  const writes: ReaderAnnotationWrites = {
    create: async (input) => {
      if (failing.has("create")) {
        return refused();
      }
      store = createGuestAnnotation({
        input,
        newId,
        now: new Date("2026-10-22T10:00:00.000Z"),
        store,
        target,
      });
      return Result.ok(store.items.at(-1)?.rowIds ?? []);
    },
    remove: async (id) => {
      if (failing.has("remove")) {
        return refused();
      }
      store = deleteGuestAnnotation(store, id);
      return Result.ok(undefined);
    },
    rows: () => guestAnnotationRows({ authorName: "You", store, target }),
    update: async (input) => {
      if (failing.has("update")) {
        return refused();
      }
      store = updateGuestAnnotation(store, input);
      return Result.ok(undefined);
    },
  };
  return { failing, writes };
};

/** A reader that records each of its own writes the way the hook does. */
const readerOn = (writes: ReaderAnnotationWrites) => {
  let history: ReaderAnnotationHistory = EMPTY_READER_ANNOTATION_HISTORY;
  let seq = 0;
  const record = (inverse: ReaderAnnotationInverse | null) => {
    seq += 1;
    if (inverse !== null) {
      history = recordReaderAnnotationStep(history, { inverse, seq });
    }
  };
  return {
    create: async (input: CreateAnnotationInput) => {
      const created = await writes.create(input);
      const ids = created.unwrap();
      record(inverseOfCreate(input, ids));
      return ids;
    },
    history: () => history,
    remove: async (id: string) => {
      const inverse = inverseOfRemove(writes.rows(), id);
      (await writes.remove(id)).unwrap();
      record(inverse);
    },
    step: async (direction: ReaderAnnotationHistoryDirection) => {
      const taken = takeReaderAnnotationStep(history, direction);
      if (taken === null) {
        return null;
      }
      const result = await performReaderAnnotationStep(
        writes,
        taken.entry.inverse,
      );
      history = settleReaderAnnotationStep({
        direction,
        entry: taken.entry,
        history: taken.history,
        result,
      });
      return {
        outcome: readerAnnotationStepOutcome(taken.entry.inverse),
        result,
      };
    },
    update: async (input: UpdateAnnotationInput) => {
      const inverse = inverseOfUpdate(writes.rows(), input);
      (await writes.update(input)).unwrap();
      record(inverse);
    },
  };
};

/** What the reader sees, without the ids a re-created mark changes. */
const visible = (writes: ReaderAnnotationWrites) =>
  writes.rows().map((row) => ({
    body: row.body,
    color: row.color,
    kind: row.kind,
    quote: row.quote,
    style: row.style,
    visibility: row.visibility,
  }));

const removeStep = (
  seq: number,
): { inverse: ReaderAnnotationInverse; seq: number } => ({
  inverse: {
    expected: [],
    op: "remove",
    rowIds: [`row-${seq}`],
    subject: "highlight",
  },
  seq,
});

describe("reader annotation history", () => {
  test("keeps steps in the order they began, even when they finish out of order", () => {
    let history = EMPTY_READER_ANNOTATION_HISTORY;
    for (const seq of [1, 3, 2]) {
      history = recordReaderAnnotationStep(history, removeStep(seq));
    }
    expect(history.undo.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(takeReaderAnnotationStep(history, "undo")?.entry.seq).toBe(3);
    expect(
      takeReaderAnnotationStep(EMPTY_READER_ANNOTATION_HISTORY, "undo"),
    ).toBeNull();
  });

  test("holds a bounded number of steps and forgets the oldest", () => {
    let history = EMPTY_READER_ANNOTATION_HISTORY;
    const total = READER_ANNOTATION_HISTORY_LIMIT + 7;
    for (let seq = 1; seq <= total; seq += 1) {
      history = recordReaderAnnotationStep(history, removeStep(seq));
    }
    expect(history.undo).toHaveLength(READER_ANNOTATION_HISTORY_LIMIT);
    expect(history.undo.at(0)?.seq).toBe(
      total - READER_ANNOTATION_HISTORY_LIMIT + 1,
    );
    expect(history.undo.at(-1)?.seq).toBe(total);
  });

  test("a new step forgets what could have been redone", () => {
    const withRedo: ReaderAnnotationHistory = {
      redo: [removeStep(1)],
      undo: [],
    };
    expect(recordReaderAnnotationStep(withRedo, removeStep(2)).redo).toEqual(
      [],
    );
  });

  test("undoing a created highlight removes it, and redo creates it again", async () => {
    const { writes } = tabStore();
    const reader = readerOn(writes);
    await reader.create(highlight);
    const marked = visible(writes);
    expect(marked).toHaveLength(2);

    expect((await reader.step("undo"))?.outcome).toBe("highlightRemoved");
    expect(writes.rows()).toEqual([]);

    expect((await reader.step("redo"))?.outcome).toBe("highlightRestored");
    expect(visible(writes)).toEqual(marked);
  });

  test("undoing a removed mark creates it again with what it held", async () => {
    for (const input of [highlight, comment] as const) {
      const { writes } = tabStore();
      const reader = readerOn(writes);
      const ids = await reader.create(input);
      const marked = visible(writes);
      // Removing through a later row of the mark still restores all of it.
      const lastRow = ids.at(-1);
      if (lastRow === undefined) {
        throw new Error("The mark has no rows");
      }
      await reader.remove(lastRow);
      expect(writes.rows()).toEqual([]);

      expect((await reader.step("undo"))?.outcome).toBe(
        input.kind === "highlight" ? "highlightRestored" : "commentRestored",
      );
      expect(visible(writes)).toEqual(marked);
      const restored = inverseOfRemove(
        writes.rows(),
        writes.rows()[0]?.id ?? "",
      );
      expect(restored?.op === "restore" ? restored.input : null).toEqual(input);
    }
  });

  test.each([
    { change: "color", color: "red", outcome: "colorRestored" },
    { change: "style", outcome: "styleRestored", style: "underline" },
    {
      change: "visibility",
      outcome: "visibilityRestored",
      visibility: "shared",
    },
  ] as const)(
    "undoing a $change change sets the previous value back",
    async ({ outcome, ...change }) => {
      const { writes } = tabStore();
      const reader = readerOn(writes);
      const [first] = await reader.create(highlight);
      if (first === undefined) {
        throw new Error("The mark has no rows");
      }
      const before = visible(writes);
      await reader.update({ id: first, ...change });
      const after = visible(writes);
      expect(after).not.toEqual(before);

      expect((await reader.step("undo"))?.outcome).toBe(outcome);
      expect(visible(writes)).toEqual(before);
      await reader.step("redo");
      expect(visible(writes)).toEqual(after);
    },
  );

  test("undoing a comment's new words puts the old words back", async () => {
    const { writes } = tabStore();
    const reader = readerOn(writes);
    const [first] = await reader.create(comment);
    if (first === undefined) {
      throw new Error("The mark has no rows");
    }
    await reader.update({ body: "Rewritten.", change: "body", id: first });
    expect((await reader.step("undo"))?.outcome).toBe("textRestored");
    expect(writes.rows()[0]?.body).toBe(comment.body);
  });

  test("a change that leaves the mark as it was is not a step", async () => {
    const { writes } = tabStore();
    const reader = readerOn(writes);
    const [first] = await reader.create(highlight);
    expect(
      inverseOfUpdate(writes.rows(), {
        change: "color",
        color: "yellow",
        id: first ?? "",
      }),
    ).toBeNull();
    expect(
      inverseOfUpdate(writes.rows(), {
        change: "color",
        color: "red",
        id: "missing",
      }),
    ).toBeNull();
  });

  test("a whole session undoes back to nothing and redoes to where it ended", async () => {
    const { writes } = tabStore();
    const reader = readerOn(writes);
    const [first] = await reader.create(highlight);
    if (first === undefined) {
      throw new Error("The mark has no rows");
    }
    const states = [visible(writes)];
    await reader.update({ change: "color", color: "violet", id: first });
    states.push(visible(writes));
    await reader.update({ change: "style", id: first, style: "squiggly" });
    states.push(visible(writes));
    await reader.remove(first);
    states.push(visible(writes));

    // Each undo returns to the state before the step, even after the mark was
    // created again under new ids.
    for (let index = states.length - 2; index >= 0; index -= 1) {
      await reader.step("undo");
      expect(visible(writes)).toEqual(states[index] ?? []);
    }
    await reader.step("undo");
    expect(writes.rows()).toEqual([]);
    expect(await reader.step("undo")).toBeNull();

    for (const state of states) {
      await reader.step("redo");
      expect(visible(writes)).toEqual(state);
    }
    expect(await reader.step("redo")).toBeNull();
  });

  test("a mark removed or changed elsewhere is left alone and the step is dropped", async () => {
    const { writes } = tabStore();
    const reader = readerOn(writes);
    const [first] = await reader.create(highlight);
    if (first === undefined) {
      throw new Error("The mark has no rows");
    }
    await reader.update({ change: "color", color: "green", id: first });
    // Another tab recolours the same mark.
    (
      await writes.update({ change: "color", color: "red", id: first })
    ).unwrap();

    expect((await reader.step("undo"))?.result.status).toBe("changed");
    expect(writes.rows()[0]?.color).toBe("red");
    expect(reader.history().redo).toEqual([]);

    // Another tab removes it: the create is no longer there to take back.
    (await writes.remove(first)).unwrap();
    expect((await reader.step("undo"))?.result.status).toBe("gone");
    expect(reader.history().undo).toEqual([]);
  });

  test("a created mark changed elsewhere is not removed by undoing its creation", async () => {
    const changes = [
      { change: "color", color: "red" },
      { change: "style", style: "underline" },
      { change: "visibility", visibility: "shared" },
    ] as const;
    for (const change of changes) {
      const { writes } = tabStore();
      const reader = readerOn(writes);
      const [first] = await reader.create(highlight);
      if (first === undefined) {
        throw new Error("The mark has no rows");
      }
      // Another tab changes the mark this tab created.
      (await writes.update({ ...change, id: first })).unwrap();
      const changed = visible(writes);

      expect((await reader.step("undo"))?.result.status).toBe("changed");
      expect(visible(writes)).toEqual(changed);
      expect(reader.history()).toEqual(EMPTY_READER_ANNOTATION_HISTORY);
    }

    const { writes } = tabStore();
    const reader = readerOn(writes);
    const [first] = await reader.create(comment);
    if (first === undefined) {
      throw new Error("The comment has no rows");
    }
    (
      await writes.update({
        body: "Rewritten in another tab.",
        change: "body",
        id: first,
      })
    ).unwrap();
    const changed = visible(writes);
    expect((await reader.step("undo"))?.result.status).toBe("changed");
    expect(visible(writes)).toEqual(changed);

    // Unchanged, the same step removes the mark.
    const fresh = tabStore();
    const freshReader = readerOn(fresh.writes);
    await freshReader.create(comment);
    expect((await freshReader.step("undo"))?.result.status).toBe("done");
    expect(fresh.writes.rows()).toEqual([]);
  });

  test("a step whose write fails stays owed and leaves the marks as they were", async () => {
    const { failing, writes } = tabStore();
    const reader = readerOn(writes);
    await reader.create(highlight);
    const marked = visible(writes);
    failing.add("remove");

    expect((await reader.step("undo"))?.result.status).toBe("failed");
    expect(visible(writes)).toEqual(marked);
    expect(reader.history().undo).toHaveLength(1);
    expect(reader.history().redo).toEqual([]);

    failing.delete("remove");
    expect((await reader.step("undo"))?.result.status).toBe("done");
    expect(writes.rows()).toEqual([]);
  });

  test("a mark created again is reached by older steps through its new rows", () => {
    const history: ReaderAnnotationHistory = {
      redo: [],
      undo: [
        {
          inverse: {
            expected: { change: "color", color: "red" },
            op: "revert",
            restore: { change: "color", color: "yellow" },
            rowIds: ["old-1", "old-2"],
            subject: "highlight",
          },
          seq: 1,
        },
        removeStep(2),
      ],
    };
    const remapped = remapReaderAnnotationRows(
      history,
      ["old-1", "old-2"],
      ["new-1", "new-2"],
    );
    expect(remapped.undo.at(0)?.inverse.rowIds).toEqual(["new-1", "new-2"]);
    expect(remapped.undo.at(1)).toEqual(removeStep(2));
  });

  test("a revert plans against the mark's current value", () => {
    const { writes } = tabStore();
    const inverse = {
      expected: { change: "style", style: "underline" },
      op: "revert",
      restore: { change: "style", style: "highlight" },
      rowIds: ["missing"],
      subject: "highlight",
    } as const satisfies ReaderAnnotationInverse;
    expect(planReaderAnnotationStep(writes.rows(), inverse)).toEqual({
      status: "gone",
    });
  });
});
