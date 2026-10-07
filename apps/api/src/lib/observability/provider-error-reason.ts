// A provider's error message can echo request content, so it is never logged.
// What is logged is the name of the known message template it matches: the
// templates below carry only item and call ids in their variable parts, and
// the name alone says which request shape the provider refused. Anything else
// is `unrecognized`.

const PROVIDER_ERROR_REASONS = [
  {
    reason: "reasoning_without_following_item",
    pattern:
      /^Item '[^']*' of type 'reasoning' was provided without its required following item\.?$/u,
  },
  {
    reason: "function_call_without_reasoning",
    pattern:
      /^Item '[^']*' of type 'function_call' was provided without its required 'reasoning' item(?:: '[^']*')?\.?$/u,
  },
  {
    reason: "function_call_output_missing",
    pattern: /^No tool output found for function call [\w-]+\.?$/u,
  },
  {
    reason: "function_call_missing",
    pattern:
      /^No tool call found for function call output with call_id [\w-]+\.?$/u,
  },
  {
    reason: "item_not_found",
    pattern: /^Item with id '[^']*' not found\.?$/u,
  },
  {
    reason: "duplicate_item",
    pattern: /^Duplicate item found with id [\w-]+\.?$/u,
  },
] as const;

export type ProviderErrorReason =
  | (typeof PROVIDER_ERROR_REASONS)[number]["reason"]
  | "unrecognized";

/** The known template `message` matches, or `unrecognized`. */
export const providerErrorReason = (message: string): ProviderErrorReason =>
  PROVIDER_ERROR_REASONS.find(({ pattern }) => pattern.test(message.trim()))
    ?.reason ?? "unrecognized";
