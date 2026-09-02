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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// The public route groups answer `404 { error: "Not Found" }` from a
// before-handle gate when the surface is off; a missing resource on an
// enabled surface carries a different body, so the marker is unambiguous.
const isDisabledPublicLawResponse = ({
  status,
  value,
}: ToAPIErrorProps): boolean =>
  status === PUBLIC_LAW_DISABLED_STATUS &&
  isRecord(value) &&
  value["error"] === PUBLIC_LAW_DISABLED_MARKER;

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
    ? new PublicLawUnavailableError({
        action,
        area: PUBLIC_LAW_AREA,
        message: "Public law is not available.",
      })
    : toAPIError(error);

/**
 * Unwraps a public-law Eden response, throwing the classified failure.
 * Taking the whole response is what makes the classification structural: a
 * helper handed unwrapped data could never see the disabled marker.
 */
export function unwrapPublicLawEden<T>(
  response: EdenResponse<T>,
  action: string,
): T {
  if (response.error) {
    throw toPublicLawError(response.error, action);
  }
  return response.data;
}
