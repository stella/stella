import type { getSafeHandlerAccessPolicy } from "../../src/lib/api-handlers";
import { ROUTE_ACCESS_DETAIL } from "../../src/lib/auth/route-access-policy";
import type { ComposedRouteRow } from "./composed-route-registry";
import { isRecord } from "./enumerate-safe-handlers";
import type {
  AccessMatrixRoute,
  RouteAccessPolicy,
} from "./route-access-matrix";

type InspectRouteAccessOptions = {
  row: ComposedRouteRow;
  registration: ReturnType<typeof getSafeHandlerAccessPolicy>;
  publicHandler: boolean;
  publicLawRoutes: ReadonlySet<string>;
  tokenLawRoutes: ReadonlySet<string>;
};

/** A missing declaration is distinct from an intentionally public handler. */
export const inspectRouteAccess = ({
  row,
  registration,
  publicHandler,
  publicLawRoutes,
  tokenLawRoutes,
}: InspectRouteAccessOptions) => {
  const detail =
    isRecord(row.hooks) && isRecord(row.hooks["detail"])
      ? row.hooks["detail"]
      : {};
  const authentication = detail[ROUTE_ACCESS_DETAIL.authentication];
  const matter = detail[ROUTE_ACCESS_DETAIL.matter];
  const config = row.endpoint?.config;
  const mcp = config?.["mcp"];
  const endpoint = row.handlerEndpoint ?? "";
  const publicLaw =
    publicLawRoutes.has(row.id) ||
    tokenLawRoutes.has(row.id) ||
    (config?.["access"] === "read" &&
      isRecord(mcp) &&
      mcp["readClass"] === "public");
  const subject = (() => {
    if (publicLaw) {
      return "public-law";
    }
    if (matter === "active" || matter === "including-archived") {
      return "matter";
    }
    if (/\/handlers\/(?:documents|files|user-files)\//u.test(endpoint)) {
      return "document";
    }
    if (
      authentication === "session" ||
      /\/handlers\/(?:auth|me|organization-settings|usage|api-keys)\//u.test(
        endpoint,
      )
    ) {
      return "org-auth";
    }
    return "other";
  })();
  const entitlementKeys = [
    "featureAccess",
    "requiresUsage",
    "actionAdmission",
  ] as const;
  const entitlements = entitlementKeys.filter(
    (key) => registration?.[key] !== undefined,
  );
  const declared = (
    auth: "public" | "session" | "organization" | "token",
    source: string,
  ) => ({
    type: "declared" as const,
    authentication: auth,
    source,
    permissions:
      registration?.permissions ??
      detail[ROUTE_ACCESS_DETAIL.permissions] ??
      null,
    accountRestriction: registration?.accountAccess ?? null,
    entitlements,
  });
  let policy: RouteAccessPolicy;
  if (
    authentication === "session" ||
    authentication === "organization" ||
    authentication === "public" ||
    authentication === "token"
  ) {
    policy = declared(
      authentication,
      `route.detail.${ROUTE_ACCESS_DETAIL.authentication}`,
    );
  } else if (tokenLawRoutes.has(row.id)) {
    policy = declared("token", "LEGAL_RESOLVE_RESOURCE_ROUTES");
  } else if (publicHandler) {
    policy = declared("public", "safe-public-handler");
  } else {
    policy = {
      type: "missing",
      reason: "No access declaration is registered for this route.",
    };
  }
  return {
    subject,
    policy,
    ...(publicLaw
      ? {
          publicLawAudience: publicLawRoutes.has(row.id)
            ? ("anonymous" as const)
            : ("authenticated" as const),
        }
      : {}),
  } satisfies Pick<
    AccessMatrixRoute,
    "subject" | "policy" | "publicLawAudience"
  >;
};
