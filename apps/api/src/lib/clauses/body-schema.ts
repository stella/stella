import * as v from "valibot";

import {
  BLOCK_DIRECTIVE_KINDS,
  type BlockDirectiveKind,
} from "@stll/template-conditions";

import {
  CLAUSE_LIST_KINDS,
  type ClauseListKind,
} from "@/api/lib/clauses/types";
import { LIMITS } from "@/api/lib/limits";

type ExactUnion<TLeft, TRight> = [
  Exclude<TLeft, TRight>,
  Exclude<TRight, TLeft>,
] extends [never, never]
  ? true
  : never;

const clauseListKindSchema = v.union([
  v.literal(CLAUSE_LIST_KINDS[0]),
  v.literal(CLAUSE_LIST_KINDS[1]),
]);
true satisfies ExactUnion<
  v.InferOutput<typeof clauseListKindSchema>,
  ClauseListKind
>;

const blockDirectiveKindSchema = v.union([
  v.literal(BLOCK_DIRECTIVE_KINDS[0]),
  v.literal(BLOCK_DIRECTIVE_KINDS[1]),
  v.literal(BLOCK_DIRECTIVE_KINDS[2]),
  v.literal(BLOCK_DIRECTIVE_KINDS[3]),
  v.literal(BLOCK_DIRECTIVE_KINDS[4]),
  v.literal(BLOCK_DIRECTIVE_KINDS[5]),
]);
true satisfies ExactUnion<
  v.InferOutput<typeof blockDirectiveKindSchema>,
  BlockDirectiveKind
>;

const clauseRunSchema = v.object({
  text: v.pipe(v.string(), v.maxLength(LIMITS.clauseExpectedBodyTextChars)),
  bold: v.exactOptional(v.boolean()),
  italic: v.exactOptional(v.boolean()),
});

const clauseParagraphSchema = v.strictObject({
  text: v.pipe(v.string(), v.maxLength(LIMITS.clauseExpectedBodyTextChars)),
  style: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
  level: v.exactOptional(v.pipe(v.number(), v.integer())),
  runs: v.exactOptional(v.pipe(v.array(clauseRunSchema), v.maxLength(1000))),
  listKind: v.exactOptional(clauseListKindSchema),
  numbering: v.exactOptional(
    v.strictObject({
      kind: v.literal("levelOnly"),
      ilvl: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(LIMITS.clauseNumberingLevelMin),
        v.maxValue(LIMITS.clauseNumberingLevelMax),
      ),
    }),
  ),
  isDirective: v.exactOptional(v.boolean()),
  directiveKind: v.exactOptional(blockDirectiveKindSchema),
  directiveExpression: v.exactOptional(v.pipe(v.string(), v.maxLength(2048))),
});

export const clauseBodySchema = v.pipe(
  v.array(clauseParagraphSchema),
  v.minLength(1),
  v.maxLength(LIMITS.clauseExpectedBodyParagraphs),
);

export const clauseExpectedBodySchema = v.pipe(
  v.array(
    v.looseObject({
      text: v.pipe(v.string(), v.maxLength(LIMITS.clauseExpectedBodyTextChars)),
    }),
  ),
  v.minLength(1),
  v.maxLength(LIMITS.clauseExpectedBodyParagraphs),
);
