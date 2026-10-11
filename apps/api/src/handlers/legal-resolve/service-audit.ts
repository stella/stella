import * as v from "valibot";

import { normalizeCountry } from "@stll/agent-input";
import { legalResolveResponseSchema } from "@stll/api-contract/legal-resolve";

import { isRecord } from "@/api/lib/type-guards";

const resolveStatusSchema = v.picklist(
  legalResolveResponseSchema.options.map(
    ({ entries }) => entries.status.literal,
  ),
);

/** Audit reads only the envelope discriminator, never corpus content or the query. */
export const serviceResolveAuditOutcome = (
  response: unknown,
  status: number,
) => {
  if (status === 429) {
    return "rate_limited" as const;
  }
  if (status >= 500) {
    return "error" as const;
  }
  if (
    status === 403 &&
    isRecord(response) &&
    response["error"] === "not_entitled"
  ) {
    return "not_entitled" as const;
  }
  if (status === 403) {
    return "missing_scope" as const;
  }
  if (status >= 400) {
    return "invalid_request" as const;
  }
  const parsed = v.safeParse(
    resolveStatusSchema,
    isRecord(response) ? response["status"] : undefined,
  );
  return parsed.success ? parsed.output : ("error" as const);
};

export const serviceResolveAuditCountry = (country: string): string => {
  const parsed = normalizeCountry(country);
  return parsed.ok ? parsed.value.alpha3 : "unknown";
};
