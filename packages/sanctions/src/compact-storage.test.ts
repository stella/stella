import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  NumberColumn,
  ObjectColumn,
  PostingColumn,
  StringMap,
} from "./compact-storage";

// Select one polynomial-hash shard to force rollover of its capped engine Maps.
const shard = (key: string): number => {
  let hash = 0;
  for (const character of key) {
    hash =
      (hash * 31 +
        (character.codePointAt(0) ?? panic("Missing fixture code point"))) %
      256;
  }
  return hash;
};

test("compact maps preserve every key and updates across a shard rollover", () => {
  const map = new StringMap<number>();
  const keys: string[] = [];
  for (let index = 0; keys.length < 4200; index += 1) {
    const key = `spelling-${index}`;
    if (shard(key) !== 0) {
      continue;
    }
    map.set(key, keys.length);
    keys.push(key);
  }
  for (const [index, key] of keys.entries()) {
    expect(map.get(key)).toBe(index);
    map.set(key, index + 1);
    expect(map.get(key)).toBe(index + 1);
  }
  expect(map.get("absent")).toBeUndefined();
});

test("compact columns and interleaved postings preserve insertion order across chunks", () => {
  const numbers = new NumberColumn();
  const floating = new NumberColumn("float");
  const objects = new ObjectColumn<string>();
  const postings = new PostingColumn();
  const first = postings.addList();
  const second = postings.addList();
  const empty = postings.addList();
  for (let index = 0; index < 8200; index += 1) {
    numbers.push(index);
    floating.push(index / 3);
    objects.push(`word-${index}`);
    postings.push(index % 2 === 0 ? first : second, index);
  }
  expect(numbers.get(4096)).toBe(4096);
  numbers.set(4096, 123);
  expect(numbers.get(4096)).toBe(123);
  for (const [index, value] of objects.entries()) {
    expect(value).toBe(`word-${index}`);
    expect(floating.get(index)).toBe(index / 3);
  }
  expect([...objects]).toHaveLength(8200);
  expect([...postings.get(first)]).toEqual(
    Array.from({ length: 4100 }, (_, index) => index * 2),
  );
  expect([...postings.get(second)]).toEqual(
    Array.from({ length: 4100 }, (_, index) => index * 2 + 1),
  );
  expect(postings.size(first)).toBe(4100);
  expect([...postings.get(empty)]).toEqual([]);
});

test("packing postings preserves empty lists, duplicate values and list order", () => {
  const postings = new PostingColumn();
  const empty = postings.addList();
  const populated = postings.addList();
  const last = postings.addList();
  for (let index = 0; index < 8200; index += 1) {
    postings.push(populated, Math.floor(index / 2));
    if (index % 3 === 0) {
      postings.push(last, index);
    }
  }
  const steps = postings.compact();
  let pauses = 0;
  for (;;) {
    const step = steps.next();
    if (!step.done) {
      pauses += 1;
      continue;
    }
    expect(pauses).toBeGreaterThan(0);
    expect([...step.value.get(empty)]).toEqual([]);
    for (const id of [populated, last]) {
      expect([...step.value.get(id)]).toEqual([...postings.get(id)]);
      expect(step.value.size(id)).toBe(postings.size(id));
    }
    break;
  }
});
