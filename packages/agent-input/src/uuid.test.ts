import { describe, expect, test } from "bun:test";

import { isAbsentPlaceholder } from "./absent";
import type { NormalizedOptional } from "./normalized";
import { normalizeUuid } from "./uuid";

const ID = "6f9619ff-8b86-4011-b42d-00cf4fc964ff";

const outcome = (result: NormalizedOptional<string>): string => {
  if (result.ok === "absent") {
    return "absent";
  }
  return result.ok ? result.value : `ask: ${result.received}`;
};

describe("record ids", () => {
  test.each([
    [ID.toUpperCase()],
    [`{${ID}}`],
    [`urn:uuid:${ID}`],
    [`URN:UUID:${ID.toUpperCase()}`],
    [ID.replaceAll("-", "")],
    [`  ${ID}\n`],
  ])("reads %s as the canonical id, with a note", (spelled) => {
    const result = normalizeUuid(spelled);
    expect(result.ok === true && result.value).toBe(ID);
    expect(result.ok === true && result.note).toBe(
      `Read ${JSON.stringify(spelled)} as "${ID}".`,
    );
  });

  test("a canonical id is taken as it is", () => {
    expect(normalizeUuid(ID)).toEqual({ ok: true, value: ID });
  });

  test("an invented id is no value, and says why", () => {
    expect(normalizeUuid("00000000-0000-0000-0000-000000000000")).toEqual({
      ok: "absent",
      received: '"00000000-0000-0000-0000-000000000000"',
      note: 'Read "00000000-0000-0000-0000-000000000000" as no value: a placeholder id, not a record.',
    });
    expect(outcome(normalizeUuid("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"))).toBe(
      "absent",
    );
    expect(outcome(normalizeUuid("11111111111111111111111111111111"))).toBe(
      "absent",
    );
  });

  test("a placeholder word is no value", () => {
    expect(normalizeUuid("any")).toEqual({
      ok: "absent",
      received: '"any"',
      note: 'Read "any" as no value.',
    });
  });

  test("anything else asks, in the caller's words when it has them", () => {
    expect(normalizeUuid("matter-42")).toEqual({
      ok: false,
      received: '"matter-42"',
      expected: "an id",
      hint: "Pass an id a previous call returned, or omit the property when not filtering by it.",
    });
    const custom = normalizeUuid(42, {
      expected: "a matter id",
      hint: "Pass a matter id list_matters returned.",
    });
    expect(custom.ok === false && custom.expected).toBe("a matter id");
    expect(custom.ok === false && custom.hint).toBe(
      "Pass a matter id list_matters returned.",
    );
  });

  test("a value that is not a string is never a placeholder", () => {
    expect(isAbsentPlaceholder(null)).toBe(false);
    expect(isAbsentPlaceholder(0)).toBe(false);
    expect(outcome(normalizeUuid(null))).toBe("ask: null");
  });
});
