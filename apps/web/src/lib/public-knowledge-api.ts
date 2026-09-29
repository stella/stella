import { TaggedError } from "better-result";

import { parseApiErrorValue } from "@stll/api-contract";

import { APIError, toAPIError } from "@/lib/errors/api";

const DISABLED_STATUS = 404;
const DISABLED_MARKER = "Not Found";
const NOT_FOUND_STATUS = 404;

/**
 * The deployment answers the catalogue routes but keeps them off. Distinct
 * from `APIError` so a page can name the cause: nothing is wrong with the
 * request, the catalogue is simply not offered here.
 */
export class PublicKnowledgeUnavailableError extends TaggedError(
  "PublicKnowledgeUnavailableError",
)<{
  action: string;
  message: string;
}> {}

/** The body the catalogue routes answer from their gate while they are off. */
type DisabledData = { readonly error: typeof DISABLED_MARKER };

const isDisabledData = (value: unknown): value is DisabledData =>
  typeof value === "object" &&
  value !== null &&
  "error" in value &&
  value.error === DISABLED_MARKER;

// A generic predicate, so the exclusion narrows each route's payload type.
const isCatalogueData = <T>(data: T): data is Exclude<T, DisabledData> =>
  !isDisabledData(data);

type ErrorInput = { status: number; value: unknown };

type EdenResponse<T> =
  | { data: T; error: null }
  | { data: null; error: ErrorInput };

/** A catalogue read's payload, without the gate's marker. */
export type PublicKnowledgeData<
  TRead extends (...args: never[]) => Promise<{ data: unknown }>,
> = Exclude<NonNullable<Awaited<ReturnType<TRead>>["data"]>, DisabledData>;

const unavailable = (action: string) =>
  new PublicKnowledgeUnavailableError({
    action,
    message: "The Knowledge catalogue is not available.",
  });

const toCatalogueError = (
  error: ErrorInput,
  action: string,
): APIError | PublicKnowledgeUnavailableError => {
  if (error.status === DISABLED_STATUS && isDisabledData(error.value)) {
    return unavailable(action);
  }
  return toAPIError({
    status: error.status,
    value: parseApiErrorValue(error.value),
  });
};

/**
 * Unwraps a catalogue read. A missing item (an unknown or unlisted pack,
 * template or starter) is an answer, `null`; the catalogue being off and
 * every other failure are raised.
 */
export function unwrapPublicKnowledge<T>(
  response: EdenResponse<T>,
  action: string,
): Exclude<T, DisabledData> | null {
  if (response.error) {
    const classified = toCatalogueError(response.error, action);
    if (APIError.is(classified) && classified.status === NOT_FOUND_STATUS) {
      return null;
    }
    throw classified;
  }
  const { data } = response;
  if (!isCatalogueData(data)) {
    throw unavailable(action);
  }
  return data;
}
