import type { PermissionInput } from "@stll/permissions";

import type { RouteAuthentication } from "./route-access-policy";

declare module "elysia" {
  interface DocumentDecoration {
    "x-stella-access-authentication"?: RouteAuthentication;
    "x-stella-access-matter"?: "active" | "including-archived";
    "x-stella-access-permissions"?: PermissionInput;
  }
}
