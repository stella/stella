import { notFound } from "@tanstack/react-router";

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
}: LoadRouteResourceOptions<T>): Promise<T> {
  if (ids.some((id) => !isUuid(id))) {
    throw notFound();
  }

  try {
    const resource = await load();
    if (!exists(resource)) {
      throw notFound();
    }
    return resource;
  } catch (error) {
    if (APIError.is(error) && MISSING_RESOURCE_STATUSES.has(error.status)) {
      throw notFound();
    }
    throw error;
  }
}
