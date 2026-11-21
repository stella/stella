import { describe, expect, test } from "bun:test";

import {
  sameEntries,
  shrinkTextViolations,
  shrinkViolations,
} from "./baseline-shrink";

const rows = [
  { file: "a.ts", fingerprint: "1", count: 2, reason: "Known A" },
  { file: "b.ts", fingerprint: "2", count: 1, reason: "Known B" },
  { file: "c.ts", fingerprint: "3", count: 4, reason: "Known C" },
];

describe("array collections", () => {
  test("deleting stale rows is a shrink", () => {
    expect(shrinkViolations(rows, [rows[0], rows[2]], [])).toEqual([]);
    expect(shrinkViolations(rows, [], [])).toEqual([]);
    expect(shrinkViolations(rows, rows, [])).toEqual([]);
  });

  test("lowering a count inside a surviving row is a shrink", () => {
    expect(
      shrinkViolations(rows, [rows[0], { ...rows[2], count: 1 }], []),
    ).toEqual([]);
  });

  test("a new row is refused", () => {
    const added = { file: "d.ts", fingerprint: "4", count: 1, reason: "New" };
    expect(shrinkViolations(rows, [...rows, added], [])).toEqual([
      "$[3] is not an existing entry",
    ]);
  });

  test("a raised count, a reworded reason or a new field is refused", () => {
    for (const changed of [
      { ...rows[1], count: 2 },
      { ...rows[1], reason: "Reworded" },
      { ...rows[1], extra: true },
      { ...rows[1], file: "other.ts" },
    ]) {
      expect(
        shrinkViolations(rows, [rows[0], changed, rows[2]], []),
      ).not.toEqual([]);
    }
  });

  test("a writer's own order is accepted, a duplicated row is not", () => {
    expect(shrinkViolations(rows, [rows[2], rows[0]], [])).toEqual([]);
    expect(shrinkViolations(rows, [rows[0], rows[0]], [])).toEqual([
      "$[1] is not an existing entry",
    ]);
    expect(sameEntries(rows, rows.toReversed())).toBe(true);
    expect(sameEntries(rows, rows.slice(1))).toBe(false);
    expect(sameEntries({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
});

describe("record collections", () => {
  const counts = { "a.ts": 1, "b.ts": 4 };
  const reasons = {
    comment: "Shrink-only. Keys: <queue>::run-actor",
    members: { "q::run-actor": "Existing gap", "r::run-actor": "Other gap" },
  };

  test("deleting keys and lowering counts is a shrink", () => {
    expect(shrinkViolations(counts, { "b.ts": 3 }, [])).toEqual([]);
    expect(
      shrinkViolations(
        reasons,
        { ...reasons, members: { "r::run-actor": "Other gap" } },
        ["members"],
      ),
    ).toEqual([]);
  });

  test("a new key or a raised count is refused", () => {
    expect(shrinkViolations(counts, { ...counts, "c.ts": 1 }, [])).toEqual([
      '$."c.ts" is not an existing entry',
    ]);
    expect(shrinkViolations(counts, { "a.ts": 2 }, [])).toEqual([
      '$."a.ts" rose from 1 to 2',
    ]);
    expect(
      shrinkViolations(
        reasons,
        { ...reasons, members: { ...reasons.members, "s::run-actor": "New" } },
        ["members"],
      ),
    ).toEqual(['$."members"."s::run-actor" is not an existing entry']);
  });

  test("everything outside the collection stays as committed", () => {
    expect(
      shrinkViolations(reasons, { ...reasons, comment: "Edited" }, ["members"]),
    ).toEqual(['$."comment" changed outside the entries']);
    expect(
      shrinkViolations(reasons, { members: reasons.members }, ["members"]),
    ).toEqual(['$."comment" was removed']);
    expect(
      shrinkViolations(reasons, { ...reasons, extra: 1 }, ["members"]),
    ).toEqual(['$."extra" was added']);
    // Dropping the container would read as "no baseline" to its writer.
    expect(shrinkViolations({ entries: {} }, {}, ["entries"])).toEqual([
      '$."entries" was removed',
    ]);
  });

  test("a collection cannot change kind", () => {
    expect(
      shrinkViolations({ entries: {} }, { entries: [] }, ["entries"]),
    ).toHaveLength(1);
    expect(shrinkViolations(rows, {}, [])).toHaveLength(1);
  });
});

test("unparsable text is refused on either side", () => {
  expect(shrinkTextViolations("{}", "{", [])).toEqual([
    "the rewritten baseline is not JSON",
  ]);
  expect(shrinkTextViolations("original\n", "{}", [])).toEqual([
    "the committed baseline is not JSON",
  ]);
  expect(shrinkTextViolations('{"a":1}', '{\n  "a": 1\n}\n', [])).toEqual([]);
});
