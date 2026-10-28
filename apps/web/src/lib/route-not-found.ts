import { notFound } from "@tanstack/react-router";
import { Result } from "better-result";

import { isUuid } from "@stll/api-contract/safe-id";

import { APIError } from "@/lib/errors/api";

type LoadRouteResourceOptions<T> = {
  ids: readonly string[];
  load: () => Promise<T>;
  exists?: (resource: T) => boolean;
};

const MISSING_RESOURCE_STATUSES = new Set([403, 404]);

/**
 * Loads a URL-addressed resource without leaking whether an inaccessible row
 * exists. URL ids and missing outcomes all become the router's 404 boundary.
 */
export async function loadRouteResource<T>({
  ids,
  load,
  exists = () => true,
}: LoadRouteResourceOptions<T>): Promise<Result<T, unknown>> {
  if (ids.some((id) => !isUuid(id))) {
    return Result.err(notFound());
  }

  const loaded = await Result.tryPromise({
    try: load,
    catch: (error) => error,
  });
  if (loaded.isErr()) {
    return Result.err(
      APIError.is(loaded.error) &&
        MISSING_RESOURCE_STATUSES.has(loaded.error.status)
        ? notFound()
        : loaded.error,
    );
  }

  return exists(loaded.value) ? loaded : Result.err(notFound());
}
