import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  DESKTOP_DICTATION_LEARNED_FIXES_PATH,
  DICTATION_LEARNED_FIX_LIMITS,
  dictationLearnedFixChangesSchema,
  dictationLearnedFixesClearQuerySchema,
  dictationLearnedFixesSchema,
} from "./dictation-learned-fixes";
import contract from "./dictation-learned-fixes.json";

const DEVICE = "4d7f8f3e-2b1c-4f7a-9a6e-1c2d3e4f5a6b";

test("the typed learned-fix contract reads the native one", () => {
  expect(contract).toStrictEqual({
    path: DESKTOP_DICTATION_LEARNED_FIXES_PATH,
    maxFixes: DICTATION_LEARNED_FIX_LIMITS.fixes,
    maxTextLength: DICTATION_LEARNED_FIX_LIMITS.textLength,
    maxWords: DICTATION_LEARNED_FIX_LIMITS.words,
    maxChangesPerRequest: DICTATION_LEARNED_FIX_LIMITS.changesPerRequest,
  });
});

test("changes carry their device's number and short fixes only", () => {
  const changes = (change: Record<string, unknown>) =>
    v.safeParse(dictationLearnedFixChangesSchema, {
      generation: 0,
      device: DEVICE,
      changes: [change],
    }).success;
  expect(
    changes({ seq: 1, type: "corrected", from: "Hrubeš", to: "Hrubesch" }),
  ).toBe(true);
  expect(changes({ seq: 1, type: "kept", from: "Hrubeš" })).toBe(true);
  expect(
    changes({ seq: 1, type: "switched", from: "Hrubeš", status: "off" }),
  ).toBe(true);
  expect(
    changes({ seq: 1, type: "switched", from: "Hrubeš", status: "learning" }),
  ).toBe(false);
  expect(changes({ type: "taught", from: "Hrubeš", to: "Hrubesch" })).toBe(
    false,
  );
  expect(
    changes({ seq: 1, type: "taught", from: "a b c d", to: "Hrubesch" }),
  ).toBe(false);
  expect(
    changes({ seq: 1, type: "taught", from: "Hrubeš\n", to: "Hrubesch" }),
  ).toBe(false);
  for (const separator of ["\u2028", "\u2029"]) {
    expect(
      changes({ seq: 1, type: "kept", from: `Hrubeš${separator}Novák` }),
    ).toBe(false);
  }
  expect(
    changes({ seq: 1, type: "taught", from: "de la Cruz", to: "De La Cruz" }),
  ).toBe(true);
  expect(changes({ seq: 1, type: "kept", from: " padded" })).toBe(false);
  expect(changes({ seq: 1, type: "kept", from: "" })).toBe(false);
  expect(changes({ seq: 1, type: "kept", from: "x".repeat(49) })).toBe(false);
  expect(
    changes({
      seq: 1,
      type: "taught",
      from: "Hrubeš",
      to: "Hrubesch",
      extra: true,
    }),
  ).toBe(false);
  expect(changes({ seq: 0, type: "kept", from: "Hrubeš" })).toBe(false);
  expect(changes({ seq: 1.5, type: "kept", from: "Hrubeš" })).toBe(false);
  expect(
    v.safeParse(dictationLearnedFixChangesSchema, {
      generation: 0,
      device: DEVICE,
      changes: [],
    }).success,
  ).toBe(false);
  // Without a device id its numbers mean nothing.
  for (const device of [undefined, "laptop"]) {
    expect(
      v.safeParse(dictationLearnedFixChangesSchema, {
        generation: 0,
        device,
        changes: [{ seq: 1, type: "kept", from: "Hrubeš" }],
      }).success,
    ).toBe(false);
  }
});

test("a deletion names the generation it deletes", () => {
  expect(
    v.parse(dictationLearnedFixesClearQuerySchema, { generation: "3" }),
  ).toStrictEqual({ generation: 3 });
  for (const generation of [undefined, "-1", "1.5", "x"]) {
    expect(
      v.safeParse(dictationLearnedFixesClearQuerySchema, { generation })
        .success,
    ).toBe(false);
  }
});

test("a snapshot holds at most the fix limit", () => {
  const fix = { from: "Hrubeš", to: "Hrubesch", seen: 2, status: "on" };
  expect(
    v.safeParse(dictationLearnedFixesSchema, {
      generation: 1,
      fixes: Array.from(
        { length: DICTATION_LEARNED_FIX_LIMITS.fixes },
        () => fix,
      ),
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(dictationLearnedFixesSchema, {
      generation: 1,
      fixes: Array.from(
        { length: DICTATION_LEARNED_FIX_LIMITS.fixes + 1 },
        () => fix,
      ),
    }).success,
  ).toBe(false);
});
