/**
 * Types derived from the `/templates/discover` endpoint response, shared by the
 * template fill form and the template wizard. Deriving them once keeps a
 * discover-schema change from half-applying: both surfaces move together
 * instead of one keeping a stale copy of the shape.
 */

import type { api } from "@/lib/api";

type DiscoverResponse = Awaited<ReturnType<typeof api.templates.discover.post>>;

type DiscoverData = Exclude<
  NonNullable<Extract<DiscoverResponse, { data: unknown }>["data"]>,
  Response
>;

export type ResolvedField = DiscoverData["fields"][number];
export type NamedCondition = DiscoverData["conditions"][number];
export type StructureError = DiscoverData["structureErrors"][number];
