// Passive regression fixture for `require-readonly-exported-collection/require-readonly-exported-collection`.

// oxlint-disable-next-line require-readonly-exported-collection/require-readonly-exported-collection -- fixture proves mutable exported Set is flagged
export const MUTABLE_SET = new Set(["a", "b"]);

// expect-clean: require-readonly-exported-collection/require-readonly-exported-collection
export const READONLY_SET: ReadonlySet<string> = new Set(["a", "b"]);

// expect-clean: require-readonly-exported-collection/require-readonly-exported-collection
export const READONLY_MAP: ReadonlyMap<string, number> = new Map([["a", 1]]);
