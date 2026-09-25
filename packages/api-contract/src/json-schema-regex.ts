import type { OverrideActionContext } from "@valibot/to-json-schema";

/**
 * JSON Schema patterns carry no flags, so the converter rejects any flagged
 * `v.regex`. Contract patterns are ASCII, where the `u` flag the lint rule
 * requires changes nothing, so the plain source is the same pattern. Pass as
 * (or chain into) the converter's `overrideAction`.
 */
export const keepUnicodePatternSource = ({
  jsonSchema,
  valibotAction,
}: OverrideActionContext) => {
  if (valibotAction.type !== "regex" || !("requirement" in valibotAction)) {
    return undefined;
  }
  const { requirement } = valibotAction;
  return requirement instanceof RegExp && requirement.flags === "u"
    ? { ...jsonSchema, pattern: requirement.source }
    : undefined;
};
