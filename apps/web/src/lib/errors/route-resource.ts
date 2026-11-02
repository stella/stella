import { notFound } from "@tanstack/react-router";
import { Result } from "better-result";

import { isUuid } from "@stll/api-contract/safe-id";

import { APIError } from "@/lib/errors/api";

type LoadRouteResourceOptions<T> = {
  ids: readonly string[];
  load: () => Promise<T>;
  exists?: (resource: T) => boolean;
};

const MISSING_RESOURCE_STATUSES = [403, 404] as const;

/**
 * Loads a URL-addressed resource without leaking whether an inaccessible row
 * exists. URL ids and missing outcomes all become the router's 404 boundary.
 */
export async function routeResourceResult<T>({
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
    const error = loaded.error;
    return Result.err(
      APIError.is(error) &&
        MISSING_RESOURCE_STATUSES.some((status) => status === error.status)
        ? notFound()
        : error,
    );
  }

  return exists(loaded.value) ? loaded : Result.err(notFound());
}

/**
 * TanStack Router consumes a loader's not-found and failures through Promise
 * rejection; this adapter translates the typed result at that framework
 * boundary, so route loaders never throw on their own.
 */
export async function loadRouteResource<T>(
  options: LoadRouteResourceOptions<T>,
): Promise<T> {
  const loaded = await routeResourceResult(options);
  if (loaded.isErr()) {
    throw loaded.error;
  }
  return loaded.value;
}
