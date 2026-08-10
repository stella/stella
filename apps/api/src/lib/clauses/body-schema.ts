import { type Static, t } from "elysia";

import {
  BLOCK_DIRECTIVE_KINDS,
  type BlockDirectiveKind,
} from "@stll/template-conditions";

import {
  CLAUSE_LIST_KINDS,
  type ClauseListKind,
} from "@/api/lib/clauses/types";

type ExactUnion<TLeft, TRight> = [
  Exclude<TLeft, TRight>,
  Exclude<TRight, TLeft>,
] extends [never, never]
  ? true
  : never;

const clauseListKindSchema = t.Union([
  t.Literal(CLAUSE_LIST_KINDS[0]),
  t.Literal(CLAUSE_LIST_KINDS[1]),
]);
true satisfies ExactUnion<Static<typeof clauseListKindSchema>, ClauseListKind>;

const blockDirectiveKindSchema = t.Union([
  t.Literal(BLOCK_DIRECTIVE_KINDS[0]),
  t.Literal(BLOCK_DIRECTIVE_KINDS[1]),
  t.Literal(BLOCK_DIRECTIVE_KINDS[2]),
  t.Literal(BLOCK_DIRECTIVE_KINDS[3]),
  t.Literal(BLOCK_DIRECTIVE_KINDS[4]),
  t.Literal(BLOCK_DIRECTIVE_KINDS[5]),
]);
true satisfies ExactUnion<
  Static<typeof blockDirectiveKindSchema>,
  BlockDirectiveKind
>;

const clauseRunSchema = t.Object({
  text: t.String(),
  bold: t.Optional(t.Boolean()),
  italic: t.Optional(t.Boolean()),
});

const clauseParagraphSchema = t.Object({
  text: t.String(),
  style: t.Optional(t.String()),
  level: t.Optional(t.Integer()),
  runs: t.Optional(t.Array(clauseRunSchema)),
  listKind: t.Optional(clauseListKindSchema),
  listLevel: t.Optional(t.Integer()),
  isDirective: t.Optional(t.Boolean()),
  directiveKind: t.Optional(blockDirectiveKindSchema),
  directiveExpression: t.Optional(t.String()),
});

export const clauseBodySchema = t.Array(clauseParagraphSchema, {
  minItems: 1,
});
