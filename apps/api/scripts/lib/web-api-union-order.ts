// The order union members print in, in apps/web/src/generated/api-routes.gen.ts.
//
// The compiler keeps a union's members sorted by type id, and a literal type's
// id is whenever the checker first happened to create it. An unrelated change
// that makes the checker meet `"neutral"` before `"unknown"` would otherwise
// reorder `"unknown" | "neutral"` in the file with no change in meaning. So
// members print in an order derived from what they are:
//
// 1. Members that print fully here (keywords, arrays and template literals of
//    them, package references), by printed text.
// 2. Members that print through a shared node (object types, tuples, anything
//    containing one), in the compiler's order. Their text is not known until
//    alias names are chosen, and those names hash the bodies that contain
//    them, so they cannot be sorted by it here.
// 3. Literals: strings by value, then numbers by value, then bigints, then
//    booleans (`false | true`).
// 4. `null`, then `undefined`.
//
// Within a rank, ties keep the printed text order, and equal text is the same
// printout either way.

/** What a union member is, as far as its place in the order goes. */
export type UnionMemberKind =
  | { type: "null" }
  | { type: "undefined" }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "bigint" }
  | { type: "boolean" }
  | { type: "other" };

export type PrintedUnionMember = {
  kind: UnionMemberKind;
  printed: string;
};

// Marks a nested node in printed text until alias names are resolved.
const NODE_TOKEN = "";

const RANK = {
  printed: 0,
  node: 1,
  literal: 2,
  null: 3,
  undefined: 4,
} as const;

const LITERAL_KIND = {
  string: 0,
  number: 1,
  bigint: 2,
  boolean: 3,
} as const;

const LITERAL_KINDS: ReadonlySet<UnionMemberKind["type"]> = new Set([
  "string",
  "number",
  "bigint",
  "boolean",
]);

const rankOf = ({ kind, printed }: PrintedUnionMember): number => {
  if (kind.type === "null") {
    return RANK.null;
  }
  if (kind.type === "undefined") {
    return RANK.undefined;
  }
  if (LITERAL_KINDS.has(kind.type)) {
    return RANK.literal;
  }
  return printed.includes(NODE_TOKEN) ? RANK.node : RANK.printed;
};

const literalKind = (kind: UnionMemberKind): number => {
  if (kind.type === "string") {
    return LITERAL_KIND.string;
  }
  if (kind.type === "number") {
    return LITERAL_KIND.number;
  }
  return kind.type === "bigint" ? LITERAL_KIND.bigint : LITERAL_KIND.boolean;
};

const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const compareBigIntText = (left: string, right: string): number => {
  const leftValue = BigInt(left.replace(/n$/u, ""));
  const rightValue = BigInt(right.replace(/n$/u, ""));
  if (leftValue === rightValue) {
    return 0;
  }
  return leftValue < rightValue ? -1 : 1;
};

const compareLiterals = (
  left: PrintedUnionMember,
  right: PrintedUnionMember,
): number => {
  const byKind = literalKind(left.kind) - literalKind(right.kind);
  if (byKind !== 0) {
    return byKind;
  }
  if (left.kind.type === "string" && right.kind.type === "string") {
    return compareText(left.kind.value, right.kind.value);
  }
  if (left.kind.type === "number" && right.kind.type === "number") {
    return left.kind.value - right.kind.value;
  }
  if (left.kind.type === "bigint") {
    return compareBigIntText(left.printed, right.printed);
  }
  return 0;
};

/** The members' printed texts in canonical order (see the file comment). */
export const orderUnionMembers = (
  members: readonly PrintedUnionMember[],
): string[] =>
  members
    .map((member, index) => ({ member, index, rank: rankOf(member) }))
    .toSorted((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }
      if (left.rank === RANK.node) {
        return left.index - right.index;
      }
      if (left.rank === RANK.literal) {
        const byValue = compareLiterals(left.member, right.member);
        if (byValue !== 0) {
          return byValue;
        }
      }
      return compareText(left.member.printed, right.member.printed);
    })
    .map(({ member }) => member.printed);
