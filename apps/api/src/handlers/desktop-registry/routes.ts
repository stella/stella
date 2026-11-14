import grant from "@/api/handlers/desktop-registry/grant";
import redeemLink from "@/api/handlers/desktop-registry/redeem-link";
import renew from "@/api/handlers/desktop-registry/renew";
import request from "@/api/handlers/desktop-registry/request";
import { routes } from "@/api/http/route";
import {
  DESKTOP_REGISTRY_REQUEST_ROUTE,
  DESKTOP_REGISTRY_ROUTE_PREFIX,
} from "@/api/lib/business-registries/desktop/request-contract";

// The desktop credential routes authorize themselves (a renewal grant, a
// signed request, a one-time link); granting needs a signed-in member.
export const desktopRegistryRoute = routes(
  {
    "/renew": { POST: renew },
    [DESKTOP_REGISTRY_REQUEST_ROUTE]: { POST: request },
    "/redeem-link": { POST: redeemLink },
    "/grant": { POST: grant },
  },
  { prefix: DESKTOP_REGISTRY_ROUTE_PREFIX },
);
