import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";

import { aiExtractablePropertyContentSchema } from "@/api/db/schema-validators";
import type { CaseLawResearchColumnContent } from "@/api/lib/case-law/research-answers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * A question column's content, built from the flat body the way a property's
 * is: the kind, plus the options a select needs.
 *
 * No `fallback`. A property falls back when the model answers null; a decision
 * honestly not settling a question is an answer here, and a select already says
 * so with its null value, so substituting a default would fabricate one.
 */
export type ResearchColumnContentInput = {
  answerType: CaseLawResearchColumnContent["type"];
  options?: { color: string; value: string }[] | undefined;
};

const isSelect = (
  answerType: ResearchColumnContentInput["answerType"],
): answerType is "single-select" | "multi-select" =>
  answerType === "single-select" || answerType === "multi-select";

const refuse = (message: string) =>
  Result.err(new HandlerError({ status: 400, message }));

/**
 * The content for one column, or why the request describes none. Validated
 * against the property model's own schema, so a question column and a matter
 * property cannot accept different option shapes.
 */
export const buildResearchColumnContent = ({
  answerType,
  options,
}: ResearchColumnContentInput): Result<
  CaseLawResearchColumnContent,
  HandlerError
> => {
  if (!isSelect(answerType)) {
    return options === undefined
      ? Result.ok({ version: 1, type: answerType })
      : refuse("Options belong to a select question");
  }

  if (options === undefined || options.length === 0) {
    return refuse("A select question needs at least one option");
  }
  const trimmed = options.map(({ color, value }) => ({
    color,
    value: value.trim(),
  }));
  if (new Set(trimmed.map((option) => option.value)).size !== trimmed.length) {
    return refuse("Options must be distinct");
  }

  const content = {
    version: 1,
    type: answerType,
    options: trimmed,
    fallback: null,
  };
  return Value.Check(aiExtractablePropertyContentSchema, content)
    ? Result.ok(content)
    : refuse("Invalid select options");
};
