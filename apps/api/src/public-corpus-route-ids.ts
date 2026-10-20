import type { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";
import type { publicLegislationRoute } from "@/api/handlers/legislation/public-routes";
import type { RoutesOf } from "@/api/lib/elysia-contract";

// Derive identifiers from the mounted Elysia registry, without importing any
// handlers at runtime or traversing their payload/response types.
type RouteIds<Tree, Path extends string = ""> = {
  [Key in keyof Tree & string]: Tree[Key] extends { response: unknown }
    ? `${Uppercase<Key>} ${Path}`
    : RouteIds<Tree[Key], `${Path}/${Key}`>;
}[keyof Tree & string];

export type PublicRouteId =
  | RouteIds<RoutesOf<typeof publicLegislationRoute>>
  | RouteIds<RoutesOf<typeof publicCaseLawRoute>>;
