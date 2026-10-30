import { Result } from "better-result";

import type { Middleware, RouteEntry } from "@/api/http/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  actionSizeErrorResponse,
  boundActionJsonResponse,
  boundActionRequest,
  getActionSizePolicy,
  withTenantActionSizePolicy,
} from "@/api/lib/rate-limit/action-size-limits";

/**
 * A tenant action is a request an organization member makes against its own
 * data: every route whose access is `member` or `workspace`. The route table
 * says so directly, so nothing has to re-derive it from the path.
 */
export const isTenantAction = (entry: RouteEntry | undefined): boolean =>
  entry?.definition.access === "member" ||
  entry?.definition.access === "workspace";

type TenantActionAdmissionOptions = {
  readonly policy?: typeof getActionSizePolicy;
  readonly enabled?: () => boolean;
};

/**
 * Bounds a tenant action's request and JSON response bytes by the deployment's
 * action size policy. A refusal is an ordinary answer, so the stages outside
 * this one (security headers, CORS, request completion) apply to it as to any
 * other.
 */
export const tenantActionAdmission =
  ({
    policy = getActionSizePolicy,
    enabled = () => isDeploymentFeatureEnabled("FEATURE_ACTION_ADMISSION"),
  }: TenantActionAdmissionOptions = {}): Middleware =>
  async (ctx, inner) => {
    if (!enabled() || !isTenantAction(ctx.routeEntry)) {
      return await inner();
    }
    const resolved = policy();
    if (Result.isError(resolved)) {
      return actionSizeErrorResponse(resolved.error);
    }
    if (resolved.value === undefined) {
      return await inner();
    }
    const limits = resolved.value;
    return await withTenantActionSizePolicy(limits, async () => {
      const bounded = await boundActionRequest(
        ctx.request,
        limits.requestBytes,
      );
      if (Result.isError(bounded)) {
        return actionSizeErrorResponse(bounded.error, limits.responseBytes);
      }
      const response = await inner({ ...ctx, request: bounded.value.request });
      return await boundActionJsonResponse(response, {
        maximum: limits.responseBytes,
        disposition:
          ctx.request.method === "GET" || ctx.request.method === "HEAD"
            ? "refuse"
            : "preserve_success",
        operation: ctx.request.method,
      });
    });
  };
