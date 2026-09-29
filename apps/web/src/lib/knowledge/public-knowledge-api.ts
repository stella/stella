import { type EdenResponse, unwrapEden } from "@/lib/errors/api";

const DISABLED_MARKER = "Not Found";
const NOT_FOUND_STATUS = 404;
const SERVICE_UNAVAILABLE_STATUS = 503;

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

/** A catalogue read's payload, without the gate's marker. */
export type PublicKnowledgeData<
  TRead extends (...args: never[]) => Promise<{ data: unknown }>,
> = Exclude<NonNullable<Awaited<ReturnType<TRead>>["data"]>, DisabledData>;

/** A failed read, raised the way every other API read is. */
const failedRead = (error: ErrorInput): EdenResponse<never> => ({
  data: null,
  error,
});

/** The catalogue being off, told apart from the request itself failing. */
const catalogueOff = (action: string): ErrorInput => ({
  status: SERVICE_UNAVAILABLE_STATUS,
  value: { message: `The Knowledge catalogue is not available (${action}).` },
});

/**
 * Unwraps a catalogue read. A missing item (an unknown or unlisted pack,
 * template or starter) is an answer, `null`; the catalogue being off and
 * every other failure are raised as API errors.
 */
export function unwrapPublicKnowledge<T>(
  response: EdenResponse<T>,
  action: string,
): Exclude<T, DisabledData> | null {
  if (response.error) {
    const { status, value } = response.error;
    if (isDisabledData(value)) {
      return unwrapEden(failedRead(catalogueOff(action)));
    }
    if (status === NOT_FOUND_STATUS) {
      return null;
    }
    return unwrapEden(failedRead(response.error));
  }
  const { data } = response;
  if (!isCatalogueData(data)) {
    return unwrapEden(failedRead(catalogueOff(action)));
  }
  return data;
}
