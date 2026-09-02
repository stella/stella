import { describe, expect, test } from "bun:test";

import {
  createBandPeekController,
  KANBAN_BAND_PEEK_DELAY_MS,
  KANBAN_BAND_PEEK_LINGER_MS,
} from "./band-peek";
import type { BandPeekScheduler } from "./band-peek";

/** A manual clock: scheduled callbacks fire only when the test advances time. */
const createClock = () => {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const schedule: BandPeekScheduler = (callback, ms) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { at: now + ms, callback });
    return () => {
      pending.delete(id);
    };
  };
  const advance = (ms: number) => {
    now += ms;
    const due = [...pending].filter(([, entry]) => entry.at <= now);
    due.sort((a, b) => a[1].at - b[1].at);
    for (const [id, entry] of due) {
      pending.delete(id);
      entry.callback();
    }
  };
  return { schedule, advance };
};

const setup = () => {
  const clock = createClock();
  const changes: (string | null)[] = [];
  const peek = createBandPeekController({
    onChange: (bandId) => {
      changes.push(bandId);
    },
    schedule: clock.schedule,
  });
  return { clock, changes, peek };
};

describe("band peek controller", () => {
  test("a pointer resting on a folded slot peeks the band open after the delay", () => {
    const { clock, changes, peek } = setup();
    peek.slotPointerMove("todo");
    clock.advance(KANBAN_BAND_PEEK_DELAY_MS - 1);
    expect(changes).toEqual([]);
    clock.advance(1);
    expect(changes).toEqual(["todo"]);
  });

  test("leaving the slot before the delay cancels the peek", () => {
    const { clock, changes, peek } = setup();
    peek.slotPointerMove("todo");
    peek.slotPointerLeave("todo");
    clock.advance(KANBAN_BAND_PEEK_DELAY_MS);
    expect(changes).toEqual([]);
  });

  // The defect this guards: folding a band from its caption left the new
  // slot under the cursor, the first movement peeked it straight back open,
  // and leaving the caption folded it again, over and over.
  test("a band folded under the pointer does not peek until the pointer leaves its slot", () => {
    const { clock, changes, peek } = setup();
    peek.foldedUnderPointer("todo");
    peek.slotPointerMove("todo");
    clock.advance(KANBAN_BAND_PEEK_DELAY_MS);
    expect(changes).toEqual([]);

    peek.slotPointerLeave("todo");
    peek.slotPointerMove("todo");
    clock.advance(KANBAN_BAND_PEEK_DELAY_MS);
    expect(changes).toEqual(["todo"]);
  });

  test("moving between the parts of an open band keeps the peek", () => {
    const { clock, changes, peek } = setup();
    peek.slotPointerMove("todo");
    clock.advance(KANBAN_BAND_PEEK_DELAY_MS);
    expect(changes).toEqual(["todo"]);

    // Caption to column: leave fires, then enter, within the linger.
    peek.openPointerLeave("todo");
    clock.advance(KANBAN_BAND_PEEK_LINGER_MS - 1);
    peek.openPointerEnter("todo");
    clock.advance(KANBAN_BAND_PEEK_LINGER_MS * 2);
    expect(changes).toEqual(["todo"]);
  });

  test("leaving an open band for longer than the linger ends the peek", () => {
    const { clock, changes, peek } = setup();
    peek.slotPointerMove("todo");
    clock.advance(KANBAN_BAND_PEEK_DELAY_MS);
    peek.openPointerLeave("todo");
    clock.advance(KANBAN_BAND_PEEK_LINGER_MS);
    expect(changes).toEqual(["todo", null]);
  });

  test("pinning a peeked band open ends the peek without a linger", () => {
    const { clock, changes, peek } = setup();
    peek.slotPointerMove("todo");
    clock.advance(KANBAN_BAND_PEEK_DELAY_MS);
    peek.bandExpanded("todo");
    expect(changes).toEqual(["todo", null]);
  });

  test("folding a peeked band from its caption ends the peek and suppresses the slot", () => {
    const { clock, changes, peek } = setup();
    peek.slotPointerMove("todo");
    clock.advance(KANBAN_BAND_PEEK_DELAY_MS);
    peek.foldedUnderPointer("todo");
    expect(changes).toEqual(["todo", null]);
    peek.slotPointerMove("todo");
    clock.advance(KANBAN_BAND_PEEK_DELAY_MS);
    expect(changes).toEqual(["todo", null]);
  });

  test("a second band's slot takes over a pending peek", () => {
    const { clock, changes, peek } = setup();
    peek.slotPointerMove("todo");
    clock.advance(KANBAN_BAND_PEEK_DELAY_MS / 2);
    peek.slotPointerLeave("todo");
    peek.slotPointerMove("done");
    clock.advance(KANBAN_BAND_PEEK_DELAY_MS);
    expect(changes).toEqual(["done"]);
  });
});
