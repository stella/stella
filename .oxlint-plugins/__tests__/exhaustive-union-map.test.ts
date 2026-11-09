import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "exhaustive-union-map";

const lint = async (lines: readonly string[]) =>
  await lintSingleRule(RULE, lines.join("\n"));

test("rejects a string-keyed map read by a dynamic key", async () => {
  expect(
    await lint([
      "declare const tier: string;",
      "const LABELS = { compliant: 'ok', deviation: 'no' } as const satisfies Record<string, string>;",
      "const ICONS: Record<string, number> = { compliant: 1, 'not-applicable': 2 };",
      "const STYLES = { draft: 'a' } satisfies Readonly<Record<string, string>>;",
      "export const read = [LABELS[tier], ICONS[tier], STYLES[tier]];",
    ]),
  ).toEqual([2, 3, 4]);
});

test("rejects a map narrowed by an own-key or `in` check", async () => {
  expect(
    await lint([
      "declare const isOwnKey: (table: object, key: string) => boolean;",
      "declare const tier: string;",
      "const A = { compliant: 'ok' } as const satisfies Record<string, string>;",
      "const B = { compliant: 'ok' } as const satisfies Record<string, string>;",
      "const C = { compliant: 'ok' } as const satisfies Record<string, string>;",
      "export const checks = [Object.hasOwn(A, tier), tier in B, isOwnKey(C, tier)];",
    ]),
  ).toEqual([3, 4, 5]);
});

test("rejects an exported lookup table, whose lookups are elsewhere", async () => {
  expect(
    await lint([
      "export const STATUS_STYLES: Record<string, string> = { draft: 'a', billed: 'b' };",
      "const PRIORITY = { urgent: 1, low: 2 } satisfies Record<string, number>;",
      "export { PRIORITY };",
    ]),
  ).toEqual([1, 2]);
});

test("allows a map keyed by its union, and named constants", async () => {
  expect(
    await lint([
      "type Tier = 'compliant' | 'deviation';",
      "declare const tier: Tier;",
      "const LABELS = { compliant: 'ok', deviation: 'no' } as const satisfies Record<Tier, string>;",
      "export const STATUS = { DRAFT: 'draft', BILLED: 'billed' } as const satisfies Record<string, string>;",
      "export const label = LABELS[tier];",
    ]),
  ).toEqual([]);
});

test("allows a map only read by property, and open-ended shapes", async () => {
  expect(
    await lint([
      "declare const key: string;",
      "declare const extra: Record<string, string>;",
      "const LOCAL = { compliant: 'ok' } satisfies Record<string, string>;",
      "const SPREAD: Record<string, string> = { ...extra, compliant: 'ok' };",
      "const COMPUTED: Record<string, string> = { [key]: 'ok' };",
      "const EMPTY: Record<string, string> = {};",
      "export const read = [LOCAL.compliant, LOCAL['compliant'], SPREAD[key], COMPUTED[key], EMPTY[key]];",
    ]),
  ).toEqual([]);
});

test("follows a map through value-preserving wrappers and default exports", async () => {
  expect(
    await lint([
      "declare const tier: string;",
      "const WRAPPED = { compliant: 'ok' } as const satisfies Record<string, string>;",
      "const ASSERTED = { compliant: 'ok' } as const satisfies Record<string, string>;",
      "const STYLES: Record<string, string> = { draft: 'a', billed: 'b' };",
      "export const read = [(WRAPPED as Record<string, string>)[tier], ASSERTED![tier]];",
      "export default STYLES;",
    ]),
  ).toEqual([2, 3, 4]);
});

test("ignores plain writes, literal own-key checks and `let` tables", async () => {
  expect(
    await lint([
      "declare const key: string;",
      "const FILLED: Record<string, number> = { draft: 0 };",
      "FILLED[key] = 1;",
      "const CHECKED = { draft: 'a' } satisfies Record<string, string>;",
      "export const STATUS = { DRAFT: 'draft' } as const satisfies Record<string, string>;",
      "let OPEN: Record<string, string> = { draft: 'a' };",
      "OPEN = { ...OPEN };",
      "export const read = [Object.hasOwn(CHECKED, 'draft'), Object.hasOwn(STATUS, 'DRAFT'), OPEN[key]];",
    ]),
  ).toEqual([]);
});

test("counts a compound assignment as a read", async () => {
  expect(
    await lint([
      "declare const key: string;",
      "const COUNTS: Record<string, number> = { draft: 0 };",
      "COUNTS[key] += 1;",
    ]),
  ).toEqual([2]);
});
