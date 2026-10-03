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
  parameterRecord[key] = 1;
  const list: unknown[] = [];
  list[names.length] = 1;
  return [fromEntries, map, fixed, fromCall, list];
};
