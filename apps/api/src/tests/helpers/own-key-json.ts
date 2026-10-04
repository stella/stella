import { panic } from "better-result";
import fc from "fast-check";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

/**
 * Keys that name a member every plain object inherits. Assigned with `=`,
 * `__proto__` reaches the prototype setter; read with `in` or `[]`, all of
 * them resolve on an object that never set them.
 */
const INHERITED_MEMBER_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
] as const;

export const ownJsonKey = fc.oneof(
  fc.constantFrom(...INHERITED_MEMBER_KEYS, "a", "b"),
  fc.string({ maxLength: 3 }),
);

type OwnKeyJsonOptions = {
  /** Whether `null` may appear as a value (object member or array element). */
  nulls: boolean;
};

/**
 * A JSON object whose keys include the inherited member names, every key an
 * own data property. Values never spell a model placeholder other than
 * `null` (when enabled): strings are non-empty.
 */
export const ownKeyJsonObject = ({
  nulls,
}: OwnKeyJsonOptions): fc.Arbitrary<Record<string, unknown>> => {
  const leaf = fc.oneof(
    fc.integer(),
    fc.boolean(),
    fc.string({ minLength: 1, maxLength: 4 }),
    ...(nulls ? [fc.constant(null)] : []),
  );
  const { object } = fc.letrec<{
    object: Record<string, unknown>;
    value: unknown;
  }>((tie) => ({
    object: fc
      .uniqueArray(fc.tuple(ownJsonKey, tie("value")), {
        maxLength: 4,
        selector: ([key]) => key,
      })
      .map((entries) => Object.fromEntries(entries)),
    value: fc.oneof(
      { depthSize: "small", maxDepth: 3 },
      leaf,
      tie("object"),
      fc.array(tie("value"), { maxLength: 3 }),
    ),
  }));
  return object;
};

/** Every object node of `value`, the root included. */
const objectNodes = (value: unknown): Record<string, unknown>[] => {
  if (isUnknownArray(value)) {
    return value.flatMap((entry) => objectNodes(entry));
  }
  if (!isRecord(value)) {
    return [];
  }
  return [
    value,
    ...Object.values(value).flatMap((entry) => objectNodes(entry)),
  ];
};

/** Whether every object node still has the plain object prototype. */
export const prototypesIntact = (value: unknown): boolean =>
  objectNodes(value).every(
    (node) => Object.getPrototypeOf(node) === Object.prototype,
  );

type WithOwnEntryOptions = {
  entry: readonly [string, unknown];
  /** Which object node receives the entry, modulo the node count. */
  nodeIndex: number;
  value: unknown;
};

/**
 * A copy of `value` with `entry` defined as a new own key of one of its object
 * nodes. `structuredClone` defines every key of the copy, `__proto__`
 * included, as own data. Call it inside a property: a node that already has
 * the key fails the run's precondition, so fast-check draws another case.
 */
export const withOwnEntry = ({
  entry: [key, entryValue],
  nodeIndex,
  value,
}: WithOwnEntryOptions): unknown => {
  const copy = structuredClone(value);
  const nodes = objectNodes(copy);
  const target =
    nodes.at(nodeIndex % nodes.length) ??
    panic("withOwnEntry needs a value with an object node");
  fc.pre(!Object.hasOwn(target, key));
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value: entryValue,
    writable: true,
  });
  return copy;
};
