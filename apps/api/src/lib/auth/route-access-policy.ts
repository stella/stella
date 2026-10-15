export const ROUTE_ACCESS_DETAIL = {
  authentication: "x-stella-access-authentication",
  matter: "x-stella-access-matter",
  permissions: "x-stella-access-permissions",
} as const;

export type RouteAuthentication =
  | "public"
  | "session"
  | "organization"
  | "token";
