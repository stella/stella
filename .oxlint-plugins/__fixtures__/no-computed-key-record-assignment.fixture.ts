// Passive regression fixture for
// `no-computed-key-record-assignment/no-computed-key-record-assignment`.
//
// Each `oxlint-disable-next-line` below suppresses a write the rule must flag;
// if the detector regresses, the directive goes unused and the fixture lint
// fails. Unsuppressed lines are writes the rule must accept.

declare const input: Record<string, unknown>;
declare const names: readonly string[];
declare const key: string;
declare const parameterRecord: Record<string, unknown>;
declare const makeRecord: () => Record<string, unknown>;

export const rebuilt = (): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [entryKey, value] of Object.entries(input)) {
    // oxlint-disable-next-line no-computed-key-record-assignment/no-computed-key-record-assignment -- fixture proves an entries rebuild is flagged
    out[entryKey] = value;
  }
  return out;
};

export const counted = (): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const name of names) {
    // oxlint-disable-next-line no-computed-key-record-assignment/no-computed-key-record-assignment -- fixture proves a counter accumulator is flagged
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
};

export const grouped = (): Record<string, string[]> => {
  const groups = {} satisfies Record<string, string[]>;
  // oxlint-disable-next-line no-computed-key-record-assignment/no-computed-key-record-assignment -- fixture proves a logical assignment through a satisfies initializer is flagged
  (groups[key] ??= []).push(key);
  return groups;
};

const moduleCache: Record<string, number> = { seeded: 1 };
export const remember = (value: number): void => {
  // oxlint-disable-next-line no-computed-key-record-assignment/no-computed-key-record-assignment -- fixture proves a module-level literal written from a function is flagged
  moduleCache[`${key}:${String(value)}`] = value;
};

export const accepted = (): unknown[] => {
  // expect-clean: no-computed-key-record-assignment/no-computed-key-record-assignment
  const fromEntries = Object.fromEntries(Object.entries(input));
  const map = new Map<string, unknown>();
  map.set(key, 1);
  const fixed: Record<string, unknown> = {};
  fixed["status-code"] = 1;
  fixed[0] = 1;
  fixed[`content-type`] = 1;
  const fromCall = makeRecord();
  fromCall[key] = 1;
  // oxlint-disable-next-line no-computed-key-record-assignment/no-computed-key-record-assignment -- fixture proves an annotated record is checked
  parameterRecord[key] = 1;
  const list: unknown[] = [];
  list[names.length] = 1;
  return [fromEntries, map, fixed, fromCall, list];
};

export const parameterWrite = (record: Record<string, unknown>): void => {
  // oxlint-disable-next-line no-computed-key-record-assignment/no-computed-key-record-assignment -- fixture checks an annotated parameter
  record[key] = 1;
};

// oxlint-disable-next-line unicorn/no-array-reduce -- fixture exercises an object-seeded reducer
export const reduced = names.reduce((record, name) => {
  // oxlint-disable-next-line no-computed-key-record-assignment/no-computed-key-record-assignment -- fixture checks an object-seeded reducer
  record[name] = 1;
  return record;
}, {});

export const nestedWrite = (): void => {
  const result = { items: {} };
  // oxlint-disable-next-line no-computed-key-record-assignment/no-computed-key-record-assignment -- fixture checks a nested literal member
  result.items[key] = 1;
};

export const assigned = (record: Record<string, unknown>): unknown =>
  // oxlint-disable-next-line no-computed-key-record-assignment/no-computed-key-record-assignment -- fixture checks a dynamic copy source
  Object.assign(record, input);

export const lookup = (name: string): number | undefined =>
  // oxlint-disable-next-line no-computed-key-record-assignment/no-computed-key-record-assignment -- fixture checks an open module table lookup
  moduleCache[name];

export const ownLookup = (name: string): number | undefined =>
  Object.hasOwn(moduleCache, name) ? moduleCache[name] : undefined;
