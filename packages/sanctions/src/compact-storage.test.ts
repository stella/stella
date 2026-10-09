import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  appendUnsigned,
  BoundedCache,
  SpellingColumn,
  stringIdsSteps,
  UnsignedReader,
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
    const iterator = step.value.get(last);
    const first = iterator.next();
    expect(first.value).toBe(0);
    expect(iterator.next().value).toBe(3);
    expect(first.value).toBe(0);
    for (const id of [populated, last]) {
      expect([...step.value.get(id)]).toEqual([...postings.get(id)]);
      expect(step.value.size(id)).toBe(postings.size(id));
    }
    break;
  }
});

test("unsigned column values round-trip across byte widths and chunk boundaries", () => {
  const bytes = new NumberColumn("byte");
  const values = [
    0, 1, 127, 128, 255, 16_383, 16_384, 65_535, 1_114_111, 4_294_967_295,
  ];
  for (let round = 0; round < 500; round += 1) {
    for (const value of values) {
      appendUnsigned(bytes, value);
    }
  }
  const reader = new UnsignedReader({ bytes, from: 0, to: bytes.length });
  for (let round = 0; round < 500; round += 1) {
    for (const value of values) {
      expect(reader.read()).toBe(value);
    }
  }
  expect(reader.done).toBe(true);
  expect(() => reader.read()).toThrow("Truncated unsigned column value");
});

test("immutable string ids preserve insertion ids, collisions and absent lookups", () => {
  const strings = new ObjectColumn<string>();
  for (let id = 0; id < 9000; id += 1) {
    strings.push(`word-${id}-𐐀`);
  }
  const steps = stringIdsSteps(strings);
  let pauses = 0;
  for (;;) {
    const step = steps.next();
    if (!step.done) {
      pauses += 1;
      continue;
    }
    expect(pauses).toBeGreaterThan(0);
    for (const [id, value] of strings.entries()) {
      expect(step.value.get(value)).toBe(id);
    }
    expect(step.value.get("absent")).toBeUndefined();
    expect(step.value.get("word-0")).toBeUndefined();
    break;
  }
});

test("packed spellings preserve Unicode and strings spanning byte chunks", () => {
  const strings = new SpellingColumn();
  const values = ["", "a".repeat(4095), "𐐨éЖ".repeat(1000), "nelori", "Αλφα"];
  for (const text of values) {
    strings.push(text);
  }
  for (const [id, text] of values.entries()) {
    expect(strings.get(id)).toBe(text);
  }
  expect(strings.length).toBe(values.length);
});

test("an object column returns stored nulls instead of treating them as missing", () => {
  const column = new ObjectColumn<string | null>();
  const present = column.push("listed");
  const absent = column.push(null);
  expect(column.get(present)).toBe("listed");
  expect(column.get(absent)).toBeNull();
  expect([...column]).toEqual(["listed", null]);
});

test("a bounded cache never holds more than its limit and evicts the least recently used entry", () => {
  const cache = new BoundedCache<number, string>(2);
  cache.set(1, "a");
  cache.set(2, "b");
  expect(cache.get(1)).toBe("a");
  cache.set(3, "c");
  expect(cache.size).toBe(2);
  expect(cache.get(2)).toBeUndefined();
  expect(cache.get(1)).toBe("a");
  expect(cache.get(3)).toBe("c");
  for (let key = 10; key < 1000; key += 1) {
    cache.set(key, String(key));
  }
  expect(cache.size).toBe(2);
});
