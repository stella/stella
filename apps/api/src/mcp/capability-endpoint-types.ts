import type * as v from "valibot";

import type { PermissionInput } from "@stll/permissions";

import type { RouteDefinition } from "@/api/http/route";
import type { WorkspaceStatusAccess } from "@/api/lib/auth/accessible-workspace";
import type { AccountAccess } from "@/api/lib/auth/account-access";
import type { FeatureAccessRequirement } from "@/api/lib/auth/feature-access/requirements";
import type { CapabilityHandlerContext } from "@/api/mcp/capability-context";

/**
 * The slice of a capability endpoint's live config the capability executors
 * read. Its input schemas are the route's own valibot schemas, and
 * `permissions` is the handler's `PermissionInput` literal; both are built by
 * the handler graph. The guard in `capability-tools.ts` narrows to this shape
 * at the module boundary.
 */
export type EndpointConfig = {
  idempotency?: { type: "replay" };
  featureAccess?: FeatureAccessRequirement;
  mcp?: unknown;
  body?: v.GenericSchema;
  params?: v.GenericSchema;
  query?: v.GenericSchema;
  permissions?: PermissionInput;
  accountAccess?: AccountAccess;
  workspaceStatus?: WorkspaceStatusAccess;
};

/** A capability's route definition, with the handler core the executors call. */
export type EndpointDefinition = Omit<RouteDefinition, "config"> & {
  readonly config: RouteDefinition["config"] & EndpointConfig;
  readonly handler: (ctx: CapabilityHandlerContext) => Promise<unknown>;
};

export type LoadCapabilityEndpoint = (
  id: string,
) => Promise<EndpointDefinition | null>;
