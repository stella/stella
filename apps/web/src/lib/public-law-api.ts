import { TaggedError } from "better-result";

import { toAPIError } from "@/lib/errors/api";
import type { APIError, EdenResponse, ToAPIErrorProps } from "@/lib/errors/api";

const PUBLIC_LAW_DISABLED_STATUS = 404;
const PUBLIC_LAW_DISABLED_MARKER = "Not Found";
const PUBLIC_LAW_AREA = "public-law";

/**
 * The deployment answers the public-law routes but keeps the surface off.
 * Distinct from `APIError` so the boundary can name the cause: the request
 * was well-formed and the server healthy; the feature is not enabled here.
 */
export class PublicLawUnavailableError extends TaggedError(
  "PublicLawUnavailableError",
)<{
  action: string;
  area: typeof PUBLIC_LAW_AREA;
  message: string;
}> {}

/**
 * The body the public route groups answer from their before-handle gate when
 * the surface is off. Eden types it into the success branch of every
 * public-law route, so the unwrap below excludes it from the data type.
 */
type DisabledPublicLawData = {
  readonly error: typeof PUBLIC_LAW_DISABLED_MARKER;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isDisabledPublicLawData = (value: unknown): boolean =>
  isRecord(value) && value["error"] === PUBLIC_LAW_DISABLED_MARKER;

// A generic predicate, so the exclusion narrows the payload type of each
// route instead of one fixed type.
const isPublicLawData = <T>(
  data: T,
): data is Exclude<T, DisabledPublicLawData> => !isDisabledPublicLawData(data);

// The gate answers with status 404, so Eden files the marker under `error`;
// a missing resource on an enabled surface carries a different body, so the
// marker is unambiguous.
const isDisabledPublicLawResponse = ({
  status,
  value,
}: ToAPIErrorProps): boolean =>
  status === PUBLIC_LAW_DISABLED_STATUS && isDisabledPublicLawData(value);

const publicLawUnavailable = (action: string) =>
  new PublicLawUnavailableError({
    action,
    area: PUBLIC_LAW_AREA,
    message: "Public law is not available.",
  });

/**
 * Classifies a failed public-law Eden response. Eden files every non-2xx
 * answer under `error`, so the disabled marker has to be read there, before
 * the generic `APIError` is raised. Call sites that branch on the failure
 * themselves (a 404 that is a real answer, a search that degrades to empty)
 * classify first and decide second.
 */
export const toPublicLawError = (
  error: ToAPIErrorProps,
  action: string,
): APIError | PublicLawUnavailableError =>
  isDisabledPublicLawResponse(error)
    ? publicLawUnavailable(action)
    : toAPIError(error);

/**
 * Unwraps a public-law Eden response, throwing the classified failure.
 * Taking the whole response is what makes the classification structural: a
 * helper handed unwrapped data could never see the disabled marker. The
 * marker is also excluded from the data type (and checked at runtime, in
 * case a gate ever answers it with a success status), so callers read the
 * payload type alone.
 */
export function unwrapPublicLawEden<T>(
  response: EdenResponse<T>,
  action: string,
): Exclude<T, DisabledPublicLawData> {
  if (response.error) {
    throw toPublicLawError(response.error, action);
  }
  const { data } = response;
  if (!isPublicLawData(data)) {
    throw publicLawUnavailable(action);
  }
  return data;
}
