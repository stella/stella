import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";

import type { CapabilityId } from "@/lib/api";

/**
 * API client request options that declare the catalog capability a write
 * runs. The API refuses the request when the declared capability does not own the route,
 * so browser writes and the capability catalog behind MCP and the CLI cannot
 * drift apart.
 */
export type CapabilityRequest = {
  readonly headers: { readonly [CAPABILITY_REQUEST_HEADER]: CapabilityId };
};

export const capabilityRequest = (
  capability: CapabilityId,
): CapabilityRequest => ({
  headers: { [CAPABILITY_REQUEST_HEADER]: capability },
});

/**
 * Runs one browser write as the named capability. Forward `request` as the
 * API client call's options (`{ ...request, query }` when the route takes a
 * query).
 */
export const invokeCapability = async <TResult>(
  capability: CapabilityId,
  call: (request: CapabilityRequest) => Promise<TResult>,
): Promise<TResult> => await call(capabilityRequest(capability));
