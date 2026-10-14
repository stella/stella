import { TaggedError } from "better-result";
import * as v from "valibot";

import {
  mcpAppFailureEnvelopeSchema,
  mcpAppRequestIdSchema,
} from "@stll/api-contract/mcp-app-failure";
import type { McpAppFailure } from "@stll/api-contract/mcp-app-failure";
import { Temporal } from "@stll/time";

import { appLocale, type AppMessageKey } from "./locale";

type AppTranslator = (
  ...args: Parameters<ReturnType<typeof appLocale>["t"]>
) => string;

export type AppMessageDescriptor = {
  key: AppMessageKey;
  values?: Parameters<AppTranslator>[1];
};

export class LocalizedAppError extends TaggedError("LocalizedAppError")<{
  message: string;
  descriptor: AppMessageDescriptor;
}> {
  constructor(descriptor: AppMessageDescriptor) {
    super({
      message: appLocale(undefined).t(descriptor.key, descriptor.values),
      descriptor,
    });
  }
}

export const formatAppError = (
  error: unknown,
  translate: AppTranslator,
  fallback: AppMessageKey,
): string => {
  if (error instanceof LocalizedAppError) {
    return translate(error.descriptor.key, error.descriptor.values);
  }
  return error instanceof Error ? error.message : translate(fallback);
};

export type AppFailure = McpAppFailure;

let requestSequence = 0;
/** Local receipts identify failures that never received a server request ID. */
export const createAppRequestId = () =>
  `app-${Temporal.Now.instant().epochMilliseconds}-${++requestSequence}`;

export const parseAppFailure = (payload: unknown): AppFailure | undefined => {
  const parsed = v.safeParse(mcpAppFailureEnvelopeSchema, payload);
  return parsed.success ? parsed.output.appFailure : undefined;
};

const FAILURE_KEYS = {
  invalid_arguments: "bridgeInvalidArguments",
  unavailable: "bridgeUnavailable",
  cancelled: "bridgeCancelled",
  invalid_response: "bridgeInvalidResponse",
  tool_failure: "bridgeToolFailure",
  permission_denied: "bridgePermissionDenied",
  not_found: "bridgeNotFound",
  rate_limited: "bridgeRateLimited",
  conflict: "bridgeConflict",
  feature_disabled: "bridgeFeatureDisabled",
  usage_limited: "bridgeUsageLimited",
} as const satisfies Record<AppFailure["type"], AppMessageKey>;

const FAILURE_FIELD_LABELS = {
  court: "court",
  courts: "court",
  country: "country",
  category: "filterCategory",
  has_legal_sentence: "filterLegalSentence",
  date_from: "from",
  date_to: "to",
  decision_type: "filterType",
  language: "filterLanguage",
  source_id: "filterSource",
  sort: "sort",
} as const satisfies Record<string, AppMessageKey>;

const isFailureField = (
  field: string,
): field is keyof typeof FAILURE_FIELD_LABELS =>
  Object.hasOwn(FAILURE_FIELD_LABELS, field);

export const formatAppFailure = (
  failure: AppFailure,
  translate: AppTranslator,
) => {
  const labels = new Set<string>();
  for (const field of failure.fields) {
    const root = field.replace(/(?:\.\d+)+$/u, "");
    if (isFailureField(root)) {
      labels.add(translate(FAILURE_FIELD_LABELS[root]));
    }
  }
  const message = translate(FAILURE_KEYS[failure.type], {
    fields: [...labels].join(", "),
  }).trim();
  return `${message} ${translate("bridgeRequestId", { requestId: failure.requestId })}`;
};

export const appFailure = (
  type: AppFailure["type"],
  requestId: string,
  retryable = false,
): AppFailure => ({
  type,
  requestId,
  retryable,
  fields: [],
  toolCode: "unknown",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const toolAppFailure = (
  payload: unknown,
  fallbackRequestId: string,
): AppFailure => {
  const internal = parseAppFailure(payload);
  if (internal !== undefined) {
    return internal;
  }
  const envelope =
    isRecord(payload) && isRecord(payload["error"])
      ? payload["error"]
      : payload;
  if (!isRecord(envelope)) {
    return appFailure("tool_failure", fallbackRequestId);
  }
  const rawCode = envelope["code"];
  const code =
    typeof rawCode === "string" && /^[a-z_]{1,80}$/u.test(rawCode)
      ? rawCode
      : "unknown";
  const rawRequestId = envelope["requestId"];
  const parsedRequestId = v.safeParse(mcpAppRequestIdSchema, rawRequestId);
  const requestId = parsedRequestId.success
    ? parsedRequestId.output
    : fallbackRequestId;
  const retryable = envelope["retryable"] === true;
  const type = (() => {
    switch (code) {
      case "validation_error":
        return "invalid_arguments";
      case "permission_denied":
      case "missing_scope":
        return "permission_denied";
      case "not_found":
        return "not_found";
      case "rate_limited":
        return "rate_limited";
      case "conflict":
        return "conflict";
      case "feature_disabled":
        return "feature_disabled";
      case "usage_limited":
        return "usage_limited";
      default:
        return "tool_failure";
    }
  })();
  const issues = v.safeParse(
    v.array(v.object({ path: v.string() })),
    envelope["issues"],
  );
  return {
    type,
    requestId,
    retryable,
    fields: issues.success ? issues.output.map(({ path }) => path) : [],
    toolCode: code,
  };
};
