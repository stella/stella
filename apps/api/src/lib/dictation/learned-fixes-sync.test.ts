import { expect, test } from "bun:test";
import fc from "fast-check";

import type { DictationLearnedFixChange } from "@stll/api-contract/dictation-learned-fixes";
import { assertProperty } from "@stll/property-testing";

import {
  type LearnedFixesState,
  REMEMBERED_DEVICES,
  unappliedChanges,
  withDeviceChanges,
} from "./learned-fixes-sync";

const DEVICES = [
  "0b8f8f3e-2b1c-4f7a-9a6e-1c2d3e4f5a01",
  "0b8f8f3e-2b1c-4f7a-9a6e-1c2d3e4f5a02",
  "0b8f8f3e-2b1c-4f7a-9a6e-1c2d3e4f5a03",
] as const;

const EMPTY: LearnedFixesState = { fixes: [], devices: [] };

/** A change without its number: what a person did. */
type Done =
  | { type: "corrected"; from: string; to: string }
  | { type: "kept"; from: string }
  | { type: "taught"; from: string; to: string }
  | { type: "switched"; from: string; status: "on" | "off" };

const phrase = fc.constantFrom("Hrubeš", "Novák", "Lorenc");
const done: fc.Arbitrary<Done> = fc.oneof(
  fc.record({
    type: fc.constant("corrected" as const),
    from: phrase,
    to: fc.constantFrom("Hrubesch", "Nowak", "Lorentz"),
  }),
  fc.record({ type: fc.constant("kept" as const), from: phrase }),
  fc.record({
    type: fc.constant("taught" as const),
    from: phrase,
    to: fc.constantFrom("Hrubesch", "Nowak", "Lorentz"),
  }),
  fc.record({
    type: fc.constant("switched" as const),
    from: phrase,
    status: fc.constantFrom("on" as const, "off" as const),
  }),
);

/** Numbers a device's changes from 1, as the device does. */
const numbered = (changes: readonly Done[]): DictationLearnedFixChange[] =>
  changes.map((change, index) => ({ ...change, seq: index + 1 }));

/**
 * A request: the device sends its next `size` changes, or repeats `size`
 * changes it already sent from `from` on, as a retry after a lost answer
 * does; `scrambled` sends them out of order with each one twice.
 */
const step = fc.record({
  device: fc.nat({ max: DEVICES.length - 1 }),
  retry: fc.boolean(),
  size: fc.integer({ min: 1, max: 5 }),
  from: fc.nat(),
  scrambled: fc.boolean(),
});

const send = (
  state: LearnedFixesState,
  device: string,
  changes: readonly DictationLearnedFixChange[],
): LearnedFixesState => withDeviceChanges(state, device, changes) ?? state;

test("retried, repeated and reordered requests end as if each change arrived once", () => {
  assertProperty(
    "retried, repeated and reordered requests end as if each change arrived once",
    fc.property(
      fc.array(fc.array(done, { maxLength: 12 }), {
        minLength: DEVICES.length,
        maxLength: DEVICES.length,
      }),
      fc.array(step, { maxLength: 40 }),
      (made, steps) => {
        const changes = made.map(numbered);
        const sent = changes.map(() => 0);
        let once = EMPTY;
        let retried = EMPTY;
        const deliver = (index: number, batch: DictationLearnedFixChange[]) => {
          const device = DEVICES[index] ?? DEVICES[0];
          retried = send(retried, device, batch);
        };
        for (const { device: index, retry, size, from, scrambled } of steps) {
          const device = DEVICES[index] ?? DEVICES[0];
          const own = changes[index] ?? [];
          const cursor = sent[index] ?? 0;
          if (retry) {
            if (cursor === 0) {
              continue;
            }
            const start = from % cursor;
            const batch = own.slice(start, Math.min(start + size, cursor));
            deliver(
              index,
              scrambled ? [...batch, ...batch].toReversed() : batch,
            );
            continue;
          }
          const batch = own.slice(cursor, cursor + size);
          if (batch.length === 0) {
            continue;
          }
          sent[index] = cursor + batch.length;
          once = send(once, device, batch);
          deliver(index, scrambled ? [...batch, ...batch].toReversed() : batch);
        }
        expect(retried).toEqual(once);
      },
    ),
  );
});

test("a change at or below the device's applied number changes nothing", () => {
  const first = withDeviceChanges(EMPTY, DEVICES[0], [
    { seq: 1, type: "corrected", from: "Hrubeš", to: "Hrubesch" },
  ]);
  expect(first?.fixes).toEqual([
    { from: "Hrubeš", to: "Hrubesch", seen: 1, status: "learning" },
  ]);
  if (first === null) {
    return;
  }
  // However many changes other devices sent in between.
  let between = first;
  for (let seq = 1; seq <= 600; seq += 1) {
    between = send(between, DEVICES[1], [{ seq, type: "kept", from: "Novák" }]);
  }
  expect(
    withDeviceChanges(between, DEVICES[0], [
      { seq: 1, type: "corrected", from: "Hrubeš", to: "Hrubesch" },
    ]),
  ).toBeNull();
});

test("changes apply in number order, each number once", () => {
  expect(
    unappliedChanges(
      [
        { seq: 3, type: "kept", from: "Novák" },
        { seq: 2, type: "taught", from: "Novák", to: "Nowak" },
        { seq: 3, type: "kept", from: "Novák" },
        { seq: 1, type: "kept", from: "Lorenc" },
      ],
      1,
    ).map(({ seq }) => seq),
  ).toEqual([2, 3]);
});

test("the remembered devices stay within their limit, the longest unsynced let go first", () => {
  let state = EMPTY;
  for (let index = 0; index <= REMEMBERED_DEVICES; index += 1) {
    state = send(state, `device-${index}`, [
      { seq: 1, type: "kept", from: "Novák" },
    ]);
  }
  expect(state.devices).toHaveLength(REMEMBERED_DEVICES);
  expect(state.devices[0]?.device).toBe("device-1");
  expect(state.devices.at(-1)?.device).toBe(`device-${REMEMBERED_DEVICES}`);
});
