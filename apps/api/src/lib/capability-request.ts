import { panic, TaggedError } from "better-result";

import {
  CAPABILITY_REQUEST_ERROR_CODE,
  CAPABILITY_REQUEST_HEADER,
} from "@stll/api-contract/capability-request";
import { declareFailureClass } from "@stll/errors";

import { toResponse } from "@/api/http/respond";
import type { Middleware, RouteDefinition } from "@/api/http/route";
import { status } from "@/api/http/status";
import { captureRequestError } from "@/api/lib/analytics/capture";
import { httpError } from "@/api/lib/errors/http-error";

/** A catalog capability and the route definition that serves it. */
export type CapabilityEndpoint = {
  readonly id: string;
  readonly definition: RouteDefinition;
};

/**
 * The catalog capability of each route definition. A capability's endpoint is
 * the very definition its route mounts, so object identity ties the two
 * without a second, hand-kept route table.
 */
export const buildCapabilityIndex = (
  endpoints: readonly CapabilityEndpoint[],
): ReadonlyMap<RouteDefinition, string> => {
  const index = new Map<RouteDefinition, string>();
  for (const { id, definition } of endpoints) {
    const existing = index.get(definition);
    if (existing !== undefined && existing !== id) {
      return panic(`capabilities ${existing} and ${id} share one definition`);
    }
    index.set(definition, id);
  }
  return index;
};

class CapabilityRequestMismatchError extends TaggedError(
  "CapabilityRequestMismatchError",
)<{
  message: string;
  declared: string;
  routeCapability: string | null;
}> {
  static {
    declareFailureClass(this, "request_invalid");
  }
}

/**
 * Refuses a request whose declared capability differs from the capability of
 * the route it reached. Requests without the header are unaffected. The index
 * is built once, on the first declaring request.
 */
export const capabilityRequestGuard = (
  loadEndpoints: () => Promise<readonly CapabilityEndpoint[]>,
): Middleware => {
  let index: Promise<ReadonlyMap<RouteDefinition, string>> | undefined;
  const getIndex = async () =>
    await (index ??= (async () =>
      buildCapabilityIndex(await loadEndpoints()))());

  return async (ctx, inner) => {
    const declared = ctx.request.headers.get(CAPABILITY_REQUEST_HEADER);
    if (declared === null) {
      return await inner();
    }
    const definition = ctx.routeEntry?.definition;
    const routeCapability =
      definition === undefined
        ? null
        : ((await getIndex()).get(definition) ?? null);
    if (routeCapability === declared) {
      return await inner();
    }
    captureRequestError(
      new CapabilityRequestMismatchError({
        message: "Declared capability does not own the matched route",
        declared,
        routeCapability,
      }),
      { request: ctx.request },
    );
    return toResponse(
      status(
        400,
        httpError(
          "The request names a capability that does not own this route.",
          CAPABILITY_REQUEST_ERROR_CODE,
        ),
      ),
      ctx.set,
    );
  };
};
