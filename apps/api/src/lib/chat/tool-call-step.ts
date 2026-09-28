// The model response (the step) a tool call came from, as its metadata
// records it. Pure, with no app environment behind it, so the scripts that
// read chat messages can import it.

import { isRecord } from "@/api/lib/type-guards";

/**
 * The metadata key naming the step a tool call came from. Stored with the
 * call, so the step a call belongs to stays readable where nothing else in
 * the message separates two steps: two calls in a row, the first denied, the
 * second asked for by the next response with no text between them.
 */
export const TOOL_CALL_STEP_METADATA_KEY = "stellaStepId";

/** The step a tool call's metadata names, if it names one. Calls stored
 *  before steps were recorded name none. */
export const toolCallStepOf = (metadata: unknown): string | undefined => {
  const step: unknown = isRecord(metadata)
    ? metadata[TOOL_CALL_STEP_METADATA_KEY]
    : undefined;
  return typeof step === "string" ? step : undefined;
};
