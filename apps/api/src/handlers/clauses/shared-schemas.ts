import { t } from "elysia";

const clauseParagraphSchema = t.Object({
  text: t.String(),
  style: t.Optional(t.String()),
  level: t.Optional(t.Integer()),
  isDirective: t.Optional(t.Boolean()),
  directiveKind: t.Optional(
    t.UnionEnum(["if", "elseif", "else", "endif", "each", "endeach"]),
  ),
  directiveExpression: t.Optional(t.String()),
});

export const clauseBodySchema = t.Array(clauseParagraphSchema, {
  minItems: 1,
});
