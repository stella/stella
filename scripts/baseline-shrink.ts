// Shrink-only comparison for committed baselines.
//
// A baseline lists known violations the ratchet tolerates. Deleting an entry,
// or lowering a count inside one, only tightens the ratchet; adding an entry,
// raising a count, or rewording a reason loosens or rewrites a reviewed
// decision. `shrinkViolations` reports every difference of the second kind, so
// an empty result means `after` can replace `before` without review.
//
// The comparison knows where entries live through `collection`: the JSON path
// of the one array or record whose members may be deleted. Everything outside
// it must be unchanged.
//
// No imports: the autofix workflow runs this file, with
// `autofix-baseline-prune.ts` and `baseline-paths.ts`, from the base
// revision's copies in an empty directory, without dependencies.

type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** `[]` is the document root; `["entries"]` is its `entries` member. */
export type CollectionPath = readonly string[];

const isRecord = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describe = (value: unknown) => {
  if (Array.isArray(value)) {
    return "array";
  }
  return value === null ? "null" : typeof value;
};

const label = (path: readonly (string | number)[]) =>
  path.length === 0
    ? "$"
    : `$${path.map((part) => (typeof part === "number" ? `[${part}]` : `.${JSON.stringify(part)}`)).join("")}`;

/** A surviving entry may only lower its counts; its shape and text stay. */
const entryViolations = (
  before: unknown,
  after: unknown,
  path: readonly (string | number)[],
): string[] => {
  if (describe(before) !== describe(after)) {
    return [
      `${label(path)} changed from ${describe(before)} to ${describe(after)}`,
    ];
  }
  if (typeof before === "number" && typeof after === "number") {
    return after <= before
      ? []
      : [`${label(path)} rose from ${before} to ${after}`];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      return [`${label(path)} changed length inside an entry`];
    }
    return before.flatMap((item, index) =>
      entryViolations(item, after[index], [...path, index]),
    );
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      key in before && key in after
        ? entryViolations(before[key], after[key], [...path, key])
        : [
            `${label([...path, key])} was ${key in after ? "added" : "removed"} inside an entry`,
          ],
    );
  }
  return Object.is(before, after) ? [] : [`${label(path)} changed`];
};

const collectionViolations = (
  before: unknown,
  after: unknown,
  path: readonly (string | number)[],
): string[] => {
  if (Array.isArray(before) && Array.isArray(after)) {
    // Writers may sort differently from the committed file, so order does
    // not matter, but each committed entry can survive at most once. An
    // unchanged entry claims its twin first, so a lowered count cannot steal
    // the twin of an identical survivor.
    const used = new Set<number>();
    const claim = (item: unknown, exact: boolean) => {
      const index = before.findIndex(
        (candidate, position) =>
          !used.has(position) &&
          (exact
            ? JSON.stringify(candidate) === JSON.stringify(item)
            : entryViolations(candidate, item, []).length === 0),
      );
      if (index !== -1) {
        used.add(index);
      }
      return index !== -1;
    };
    const pending = after
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !claim(item, true));
    return pending
      .filter(({ item }) => !claim(item, false))
      .map(
        ({ index }) => `${label([...path, index])} is not an existing entry`,
      );
  }
  if (isRecord(before) && isRecord(after)) {
    return Object.keys(after).flatMap((key) =>
      key in before
        ? entryViolations(before[key], after[key], [...path, key])
        : [`${label([...path, key])} is not an existing entry`],
    );
  }
  return [
    `${label(path)} must stay a collection, not ${describe(before)} to ${describe(after)}`,
  ];
};

const documentViolations = (
  before: unknown,
  after: unknown,
  collection: CollectionPath,
  path: readonly string[],
): string[] => {
  if (collection.length === path.length) {
    return collectionViolations(before, after, path);
  }
  if (!isRecord(before) || !isRecord(after)) {
    return [`${label(path)} must stay an object`];
  }
  const next = collection[path.length] ?? "";
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((key) => {
    if (!(key in before) || !(key in after)) {
      return [
        `${label([...path, key])} was ${key in after ? "added" : "removed"}`,
      ];
    }
    if (key === next) {
      return documentViolations(before[key], after[key], collection, [
        ...path,
        key,
      ]);
    }
    return JSON.stringify(before[key]) === JSON.stringify(after[key])
      ? []
      : [`${label([...path, key])} changed outside the entries`];
  });
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).toSorted().join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/** True when `after` holds exactly `before`'s entries, perhaps reordered. */
export const sameEntries = (before: unknown, after: unknown): boolean =>
  canonical(before) === canonical(after);

/** Every way `after` adds to or loosens `before`; empty when it only shrinks. */
export const shrinkViolations = (
  before: unknown,
  after: unknown,
  collection: CollectionPath,
): string[] => documentViolations(before, after, collection, []);

/** Parse both texts and compare; unparsable text is itself a violation. */
export const shrinkTextViolations = (
  before: string,
  after: string,
  collection: CollectionPath,
): string[] => {
  const parse = (text: string): { value: unknown } | null => {
    // Dependency-free on purpose (see the header), so no Result helper.
    try {
      return { value: JSON.parse(text) };
    } catch {
      return null;
    }
  };
  const parsedBefore = parse(before);
  if (parsedBefore === null) {
    return ["the committed baseline is not JSON"];
  }
  const parsedAfter = parse(after);
  if (parsedAfter === null) {
    return ["the rewritten baseline is not JSON"];
  }
  return shrinkViolations(parsedBefore.value, parsedAfter.value, collection);
};
