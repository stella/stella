/**
 * Canonical structured-condition AST shared across the
 * workspace: view filters, AI-extraction gating, playbook
 * matching, and (via a string parser) DOCX template
 * conditionals. One representation, one evaluator, one set of
 * operators. Surface syntaxes (a visual builder, an inline
 * `{{#if ...}}` string) parse into this AST; they are not
 * competing models.
 *
 * Pure schema module: valibot only, no runtime side effects,
 * usable on both backend (Bun) and frontend (browser).
 */
import * as v from "valibot";

// ── Operators ─────────────────────────────────────────────

/** Binary comparisons between two operands. */
export const COMPARE_OPS = ["eq", "neq", "gt", "lt", "gte", "lte"] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];

/** Operand-plus-payload tests (membership, emptiness, truthiness, text). */
export const PREDICATE_OPS = [
  "is_empty",
  "is_not_empty",
  "is_truthy",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "contains_all",
  "in",
] as const;
export type PredicateOp = (typeof PREDICATE_OPS)[number];

/** Predicate operators that carry no payload value. */
export const NULLARY_PREDICATE_OPS = [
  "is_empty",
  "is_not_empty",
  "is_truthy",
] as const;

export const BUILTIN_FIELDS = ["status", "priority"] as const;
export type BuiltinField = (typeof BUILTIN_FIELDS)[number];

export const COMBINATORS = ["and", "or"] as const;
export type Combinator = (typeof COMBINATORS)[number];

// ── Operands ──────────────────────────────────────────────

const literalValueSchema = v.union([
  v.string(),
  v.number(),
  v.boolean(),
  v.array(v.string()),
]);

export type LiteralValue = v.InferOutput<typeof literalValueSchema>;

/**
 * A value reference. Domain adapters resolve every operand
 * except `literal` (which the evaluator resolves directly):
 *  - `property`/`builtin`/`kind` are the Table domain.
 *  - `path` is the DOCX template fill-bag surface.
 *  - `formula` is an arithmetic expression over numeric fields
 *    (e.g. `rent * 12`); only the JS-evaluated template domain
 *    resolves it (SQL filters strip it at the boundary), so a
 *    comparison can read `rent * 12 < 100000`.
 */
export const operandSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("property"),
    propertyId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    type: v.literal("builtin"),
    field: v.picklist(BUILTIN_FIELDS),
  }),
  v.strictObject({ type: v.literal("kind") }),
  v.strictObject({
    type: v.literal("path"),
    path: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    type: v.literal("formula"),
    expr: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({ type: v.literal("literal"), value: literalValueSchema }),
]);

export type Operand = v.InferOutput<typeof operandSchema>;
/** Any operand the domain adapter must resolve (everything but a literal). */
export type RefOperand = Exclude<Operand, { type: "literal" }>;

// ── Nodes ─────────────────────────────────────────────────

export type CompareNode = {
  type: "compare";
  left: Operand;
  op: CompareOp;
  right: Operand;
};

export type PredicateNode = {
  type: "predicate";
  operand: Operand;
  op: PredicateOp;
  /** Payload for `contains`/`contains_all`/`in`; omitted for nullary ops. */
  value?: string | string[] | undefined;
};

export type GroupNode = {
  type: "group";
  combinator: Combinator;
  negated?: boolean | undefined;
  children: ConditionNode[];
};

export type ConditionNode = CompareNode | PredicateNode | GroupNode;

// Leaf schemas stay concrete (not annotated as GenericSchema) so they
// remain valid `v.variant` options; only the recursive reference is lazy.
const compareSchema = v.strictObject({
  type: v.literal("compare"),
  left: operandSchema,
  op: v.picklist(COMPARE_OPS),
  right: operandSchema,
});

const predicateSchema = v.strictObject({
  type: v.literal("predicate"),
  operand: operandSchema,
  op: v.picklist(PREDICATE_OPS),
  value: v.optional(v.union([v.string(), v.array(v.string())])),
});

const groupSchema = v.strictObject({
  type: v.literal("group"),
  combinator: v.picklist(COMBINATORS),
  negated: v.optional(v.boolean()),
  children: v.array(
    v.lazy((): v.GenericSchema<ConditionNode> => conditionNodeSchema),
  ),
});

export const conditionNodeSchema: v.GenericSchema<ConditionNode> = v.variant(
  "type",
  [compareSchema, predicateSchema, groupSchema],
);

/** A top-level condition is always a group (the AND/OR root). */
export const conditionSchema = groupSchema;
export type Condition = GroupNode;

/** An empty AND root: matches everything (the "no filter" identity). */
export const emptyCondition = (): Condition => ({
  type: "group",
  combinator: "and",
  children: [],
});
