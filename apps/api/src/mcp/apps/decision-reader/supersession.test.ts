import { expect, test } from "bun:test";

import {
  connectReaderSupersession,
  isNewerReaderInstance,
} from "./supersession";

const identity = {
  sequence: 1,
  instance: "00000000-0000-4000-8000-000000000001",
};
const later = { sequence: 2, instance: "00000000-0000-4000-8000-000000000002" };

test("reader instance ordering rejects invalid data and resolves equal-time openings consistently", () => {
  for (const payload of [
    null,
    {},
    identity,
    { ...identity, sequence: 0 },
    { ...later, sequence: Number.NaN },
    { ...later, sequence: Infinity },
    { ...later, sequence: 1.5 },
    { ...later, instance: "invalid" },
  ]) {
    expect(isNewerReaderInstance(identity, payload)).toBe(false);
  }
  expect(isNewerReaderInstance(identity, later)).toBe(true);
  const tied = { ...later, sequence: identity.sequence };
  expect(isNewerReaderInstance(identity, tied)).toBe(true);
  expect(isNewerReaderInstance(tied, identity)).toBe(false);
});

test("reader supersession announces once, supersedes once and releases its channel on cleanup", () => {
  const listeners = new Set<(payload: unknown) => void>();
  const messages: unknown[] = [];
  let superseded = 0;
  let closed = 0;
  const dispose = connectReaderSupersession({
    identity,
    supersede: () => {
      superseded += 1;
    },
    channel: {
      send: (message) => {
        messages.push(message);
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close: () => {
        closed += 1;
      },
    },
  });
  expect(messages).toEqual([identity]);
  for (const listener of listeners) {
    listener(identity);
    listener(null);
  }
  expect(superseded).toBe(0);
  for (const listener of listeners) {
    listener(later);
    listener({ ...later, sequence: 3 });
  }
  expect(superseded).toBe(1);
  dispose();
  dispose();
  expect(listeners.size).toBe(0);
  expect(closed).toBe(1);
});
