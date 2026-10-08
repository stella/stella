import { isRecord } from "@/api/lib/type-guards";

// A provider's error message can echo request content, so it is never logged.
// What is logged is the name of the known message template it matches: the
// templates below carry only item and call ids in their variable parts, and
// the name alone says which request shape the provider refused. Anything else
// is `unrecognized`.
//
// A template matches the whole message, except where the provider follows its
// first sentence with fixed advice (`item_not_found`): there the first
// sentence decides, so the advice can change without hiding the reason.

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
    pattern: /^Item with id '[^']*' not found(?:\.?$|\. )/u,
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

// The structural fields of a provider's error body: OpenAI's `code`, `param`
// and `type`. They name what was refused (`invalid_request_error`, `input`,
// `input[3].call_id`), never what the request said; the body's `message` is
// never read here. A value that is not a short token is logged as `other`, so
// free text cannot ride under these keys.
const PROVIDER_ERROR_TOKEN = /^[\w.:[\]-]{1,64}$/u;
const PROVIDER_ERROR_FIELDS = ["code", "param", "type"] as const;

/** The provider error body `detail` carries: itself, or its `error` field
 *  (an SDK error keeps the body there). */
const providerErrorBodyOf = (
  detail: unknown,
): Record<string, unknown> | undefined => {
  if (!isRecord(detail)) {
    return undefined;
  }
  const nested = detail["error"];
  if (isRecord(nested)) {
    return nested;
  }
  return detail;
};

/** `error.provider.code`, `.param` and `.type` for a provider error body. */
export const providerErrorFields = (
  detail: unknown,
): Record<string, string> => {
  const body = providerErrorBodyOf(detail);
  if (body === undefined) {
    return {};
  }
  return Object.fromEntries(
    PROVIDER_ERROR_FIELDS.flatMap((field): [string, string][] => {
      const value = body[field];
      if (typeof value !== "string" || value === "") {
        return [];
      }
      return [
        [
          `error.provider.${field}`,
          PROVIDER_ERROR_TOKEN.test(value) ? value : "other",
        ],
      ];
    }),
  );
};
