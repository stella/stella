import * as v from "valibot";

import { chatLocalRunSteerInputSchema } from "@stll/api-contract/chat-run-target";

const steerArgumentsSchema = v.pipe(
  v.string(),
  v.parseJson(),
  chatLocalRunSteerInputSchema,
);

/**
 * What the member wrote, from a steered message's stored call arguments;
 * `null` when they do not hold it.
 */
export const steeredMessageText = (args: string): string | null => {
  const parsed = v.safeParse(steerArgumentsSchema, args);
  return parsed.success ? parsed.output.text : null;
};
