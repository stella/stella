import { describe, expect, setDefaultTimeout, test } from "bun:test";

import plugin from "../no-computed-key-record-assignment.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (lines: readonly string[]) =>
  await lintSingleRule(
    "no-computed-key-record-assignment",
    [...lines, ""].join("\n"),
  );

describe.serial("no-computed-key-record-assignment", () => {
  test("distinguishes open key unions and local aliases from closed key types", async () => {
    expect(
      await lint([
        "type Open = string; type Closed = 'a' | 'b';",
        "const TABLE: Record<string, number> = {};",
        "const UNION: Record<string | number, number> = {};",
        "export const alias = (key: Open) => TABLE[key];",
        "export const union = (key: string | number) => TABLE[key];",
        "export const tableUnion = (key: string) => UNION[key];",
        "export const closed = (key: Closed) => TABLE[key];",
      ]),
    ).toEqual([4, 5, 6]);
  });

  test("sees through the global Readonly wrapper but not a local one", async () => {
    expect(
      await lint([
        "const FROZEN: Readonly<Record<string, number>> = {};",
        "type Table = Readonly<Record<string, number>>;",
        "const ALIASED: Table = {};",
        "const OPERATOR: { readonly [key: string]: number } = {};",
        "export const frozen = (key: string) => FROZEN[key];",
        "export const aliased = (key: string) => ALIASED[key];",
        "export const operator = (key: string) => OPERATOR[key];",
        "export const guarded = (key: string) => Object.hasOwn(FROZEN, key) ? FROZEN[key] : undefined;",
        "export const closed = (key: 'a') => FROZEN[key];",
        "const local = () => { type Readonly<T> = { ok: T }; const SHADOW: Readonly<Record<string, number>> = { ok: {} }; return (key: string) => SHADOW[key]; };",
        "export { local };",
      ]),
    ).toEqual([5, 6, 7]);
  });

  test("terminates local alias and class-field cycles", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "type Cycle = Cycle; type RecursiveUnion = RecursiveUnion | number;",
        "const TABLE: Record<string, number> = {};",
        "export const read = (key: RecursiveUnion) => TABLE[key];",
        "export const write = (out: Cycle) => { out[key] = 1; };",
        "let first = second; let second = first;",
        "first[key] = 1;",
        "class Cache { cache = this.cache; put() { this.cache[key] = 1; } }",
      ]),
    ).toEqual([]);
  });

  test("resolves destructured annotations and statically named nested members", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "export const write = ({out}: {out: Record<string, number>}) => { out[key] = 1; };",
        "export const renamed = ({out: record}: {out: Record<string, number>}) => { record[key] = 1; };",
        "export const nested = ({outer: {out}}: {outer: {out: Record<string, number>}}) => { out[key] = 1; };",
        "const out = { ['items']: {} };",
        "out.items[key] = 1;",
        "const TABLE: Record<string, number> = {};",
        "export const read = ({key}: {key: string}) => TABLE[key];",
        "export const closed = ({key}: {key: 'a' | 'b'}) => TABLE[key];",
        "export const array = ({out}: {out: number[]}, key: number) => { out[key] = 1; };",
      ]),
    ).toEqual([2, 3, 4, 6, 8]);
  });

  test("recognizes compound checks and the positive branch of negated checks", async () => {
    expect(
      await lint([
        "const TABLE: Record<string, number> = {};",
        "export const compound = (key: string) => {",
        "  if (Object.hasOwn(TABLE, key) && key !== '') return TABLE[key];",
        "  if (key !== '' && Object.hasOwn(TABLE, key)) return TABLE[key];",
        "};",
        "export const alternate = (key: string) => {",
        "  if (!Object.hasOwn(TABLE, key)) return undefined; else return TABLE[key];",
        "};",
        "export const ternary = (key: string) => !Object.hasOwn(TABLE, key) ? undefined : TABLE[key];",
        "export const loose = (key: string, flag: boolean) => {",
        "  if (Object.hasOwn(TABLE, key) || flag) return TABLE[key];",
        "};",
        "export const changed = (key: string) => {",
        "  if (Object.hasOwn(TABLE, key) && (key = 'different')) return TABLE[key];",
        "};",
      ]),
    ).toEqual([11, 14]);
  });

  test("checks string assertions without treating closed assertions as open keys", async () => {
    expect(
      await lint([
        "const TABLE: Record<string, number> = {};",
        "export const asserted = (key: unknown) => TABLE[key as string];",
        "export const closed = (key: unknown) => TABLE[key as 'a' | 'b'];",
        "export const guarded = (key: string) => Object.hasOwn(TABLE, key) ? TABLE[key as string] : undefined;",
      ]),
    ).toEqual([2]);
  });

  test("a guard must match the binding and still apply at the read", async () => {
    expect(
      await lint([
        "import { hasOwnKey as owns } from '@/api/lib/json-value';",
        "const TABLE: Record<string, number> = {};",
        "export const helper = (key: string) => owns(TABLE, key) ? TABLE[key] : undefined;",
        "export const changed = (key: string) => {",
        "  if (!Object.hasOwn(TABLE, key)) return undefined;",
        "  key = 'different';",
        "  return TABLE[key];",
        "};",
        "export const nested = (key: string) => {",
        "  if (Object.hasOwn(TABLE, key)) return () => TABLE[key];",
        "};",
        "export const unrelated = (key: string) => {",
        "  if (Object.hasOwn(TABLE, key)) { /* check ends here */ }",
        "  return TABLE[key];",
        "};",
        "export const shadow = (Object: { hasOwn: (...args: unknown[]) => boolean }, key: string) => Object.hasOwn(TABLE, key) ? TABLE[key] : undefined;",
        "const hasOwnKey = () => true;",
        "export const fake = (key: string) => hasOwnKey(TABLE, key) ? TABLE[key] : undefined;",
      ]),
    ).toEqual([7, 10, 14, 16, 18]);
  });

  test("reports increment writes and accepts seeded array reducers", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "const list = [];",
        "list.reduce((acc, value) => { acc[key] = value; return acc; }, []);",
        "const counts = {};",
        "counts[key]++;",
      ]),
    ).toEqual([5]);
  });

  test("reports typed parameters, reducers and outer callback records", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "export const write = (out: Record<string, number>, empty: {}) => {",
        "  out[key] = 1;",
        "  empty[key] = 1;",
        "};",
        "const entries: [string, number][] = [];",
        "entries.reduce((acc, [key, value]) => {",
        "  acc[key] = value;",
        "  return acc;",
        "}, {});",
        "const out = {};",
        "entries.forEach(([key, value]) => { out[key] = value; });",
      ]),
    ).toEqual([3, 4, 8, 12]);
  });

  test("resolves nested literal, annotated and instance members", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "const out = { items: {} };",
        "out.items[key] = 1;",
        "declare const tree: Record<string, Record<string, number>>;",
        "tree[key][key] = 1;",
        "export const write = (out: { items: Record<string, number> }) => {",
        "  out.items[key] = 1;",
        "};",
        "class Cache {",
        "  cache: Record<string, number> = {};",
        "  put() { this.cache[key] = 1; }",
        "}",
        "type Values = Record<string, number>;",
        "export const alias = (out: Values) => { out[key] = 1; };",
      ]),
    ).toEqual([3, 5, 5, 7, 11, 14]);
  });

  test("reports dynamic assign sources and accepts literal or spread copies", async () => {
    expect(
      await lint([
        "declare const source: Record<string, number>;",
        "Object.assign({}, source);",
        "Object.assign({}, { fixed: 1 }, source);",
        "Object.assign({}, ...[source]);",
        "Object.assign(...[{}, source]);",
        "Object.assign({}, { fixed: 1 });",
        "Object.assign({}, { ...source });",
        "const copied = { ...source };",
        "const built = fromOwnEntries(ownEntries(source));",
        "const shadow = (Object: { assign: (...args: unknown[]) => unknown }) => Object.assign({}, source);",
      ]),
    ).toEqual([2, 3, 4, 5]);
  });

  test("accepts object spread inside map callbacks and reports Object.assign there", async () => {
    expect(
      await lint([
        "declare const rows: readonly Record<string, number>[];",
        "declare const extra: Record<string, number>;",
        "export const spread = rows.map((row) => ({ ...row, ...extra }));",
        "export const assigned = rows.map((row) => Object.assign({}, row, extra));",
      ]),
    ).toEqual([4]);
  });

  test("names object spread as the one record-copy form", () => {
    expect(
      plugin.rules["no-computed-key-record-assignment"]?.meta?.messages
        ?.assignedSource,
    ).toBe(
      "Copy dynamic entries with object spread ({ ...target, ...source }).",
    );
  });

  test("requires an own-key guard for open module table reads", async () => {
    expect(
      await lint([
        "const TABLE: Record<string, number> = { fixed: 1 };",
        "export const read = (key: string) => TABLE[key];",
        "export const guarded = (key: string) => {",
        "  if (Object.hasOwn(TABLE, key)) return TABLE[key];",
        "  return undefined;",
        "};",
        "export const early = (key: string) => {",
        "  if (!Object.hasOwn(TABLE, key)) return undefined;",
        "  return TABLE[key];",
        "};",
        "export const expression = (key: string) => Object.hasOwn(TABLE, key) ? TABLE[key] : undefined;",
        "export const logical = (key: string) => Object.hasOwn(TABLE, key) && TABLE[key];",
        "export const wrong = (key: string, other: string) => {",
        "  if (Object.hasOwn(TABLE, other)) return TABLE[key];",
        "};",
        "export const unchecked = (key: string) => {",
        "  Object.hasOwn(TABLE, key);",
        "  return TABLE[key];",
        "};",
        "export const wrongBranch = (key: string) => {",
        "  if (Object.hasOwn(TABLE, key)) return undefined;",
        "  return TABLE[key];",
        "};",
      ]),
    ).toEqual([2, 14, 18, 22]);
  });

  test("accepts array and Map parameters, nested arrays and closed keys", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "declare const index: number;",
        "const TABLE: Record<string, number> = {};",
        "const CLOSED: Record<'a' | 'b', number> = { a: 1, b: 2 };",
        "export const closed = (key: 'a' | 'b') => TABLE[key];",
        "export const typedTable = (key: string) => CLOSED[key];",
        "export const local = (key: string) => {",
        "  const TABLE: Record<string, number> = {};",
        "  return TABLE[key];",
        "};",
        "export const writes = (array: number[], tuple: [number, number], map: Map<string, number>) => {",
        "  array[index] = 1; tuple[index] = 1; map.set(key, 1);",
        "};",
        "const nested = { items: [] as number[] };",
        "nested.items[index] = 1;",
        "declare const tree: Record<string, number[]>;",
        "if (Object.hasOwn(tree, key)) tree[key][index] = 1;",
        "class Arrays { cache: number[] = []; put() { this.cache[index] = 1; } }",
      ]),
    ).toEqual([]);
  });

  test("reports a record rebuilt by computed-key assignment", async () => {
    expect(
      await lint([
        "declare const input: Record<string, unknown>;",
        "export const copy = () => {",
        "  const out: Record<string, unknown> = {};",
        "  for (const [key, value] of Object.entries(input)) {",
        "    out[key] = value;",
        "  }",
        "  return out;",
        "};",
      ]),
    ).toEqual([5]);
  });

  test("reports every assignment operator and wrapped initializers", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "const counts = {} as Record<string, number>;",
        "const groups = {} satisfies Record<string, string[]>;",
        "let seeded = { a: 1 };",
        "counts[key] = (counts[key] ?? 0) + 1;",
        "counts[key] += 1;",
        "(groups[key] ??= []).push(key);",
        "seeded[key] ||= 2;",
      ]),
    ).toEqual([5, 5, 6, 6, 7, 7, 8]);
  });

  test("reports a module-level record written from a function", async () => {
    expect(
      await lint([
        "const cache: Record<string, number> = {};",
        "export const remember = (key: string) => {",
        "  cache[key] = 1;",
        "};",
      ]),
    ).toEqual([3]);
  });

  test("accepts static keys, other receivers, and own-property builders", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "declare const input: Record<string, unknown>;",
        "declare const make: () => Record<string, unknown>;",
        "export const accepted = (param: Record<string, unknown>) => {",
        "  const fixed: Record<string, unknown> = {};",
        '  fixed["status"] = 1;',
        "  fixed[0] = 1;",
        "  fixed[`literal`] = 1;",
        "  // typed parameters are checked separately",
        "  const made = make();",
        "  made[key] = 1;",
        "  const list: unknown[] = [];",
        "  list[list.length] = 1;",
        "  const map = new Map<string, unknown>([[key, 1]]);",
        "  return [fixed, made, list, map, Object.fromEntries(Object.entries(input))];",
        "};",
      ]),
    ).toEqual([]);
  });

  test("resolves the receiver by scope, not by name", async () => {
    expect(
      await lint([
        "declare const key: string;",
        "const out: Record<string, unknown> = {};",
        "export const shadowed = (out: Record<string, unknown>) => {",
        "  out[key] = 1;",
        "};",
        "export const reported = () => {",
        "  out[key] = 1;",
        "};",
      ]),
    ).toEqual([4, 7]);
  });
});
