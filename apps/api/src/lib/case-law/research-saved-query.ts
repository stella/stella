import { Result } from "better-result";
import * as v from "valibot";

import { CASE_LAW_RESEARCH_QUERY_VERSION } from "@stll/api-contract";
import type { CaseLawResearchSavedQuery } from "@stll/api-contract";

import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

// `exactOptional`: an absent filter is absent, never `undefined`, so the parsed
// value is the contract type itself under `exactOptionalPropertyTypes`.
const optionalFilter = (maxLength: number) =>
  v.exactOptional(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maxLength)),
  );

/**
 * The saved query a research table re-runs. Validated here rather than only
 * in the route schema because the same value arrives from the HTTP body today
 * and from other entry points later; the shape mirrors the public decision
 * search body so the client passes it through unchanged.
 */
export const caseLawResearchSavedQuerySchema = v.strictObject({
  version: v.literal(CASE_LAW_RESEARCH_QUERY_VERSION),
  query: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
  ),
  country: optionalFilter(3),
  court: optionalFilter(512),
  dateFrom: v.exactOptional(v.pipe(v.string(), v.isoDate())),
  dateTo: v.exactOptional(v.pipe(v.string(), v.isoDate())),
  decisionType: optionalFilter(128),
  language: optionalFilter(8),
  sourceId: v.exactOptional(
    v.pipe(
      v.string(),
      v.uuid(),
      v.transform((value) => toSafeId<"caseLawSource">(value)),
    ),
  ),
});

export const parseCaseLawResearchSavedQuery = (
  value: unknown,
): Result<CaseLawResearchSavedQuery, HandlerError> => {
  const parsed = v.safeParse(caseLawResearchSavedQuerySchema, value);
  if (!parsed.success) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid research table query",
      }),
    );
  }
  return Result.ok(parsed.output);
};
