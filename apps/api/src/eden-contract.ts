import type Elysia from "elysia";

import type { memoriesRoute } from "@/api/handlers/memories/routes";
import type api from "@/api/server.js";

type ApiRoutes = (typeof api)["~Routes"];
type ApiV1Routes = ApiRoutes["v1"];
type ApiEntityRoutes = ApiV1Routes["entities"];
type ApiWorkspaceEntityRoutes = ApiEntityRoutes[":workspaceId"];
type ApiEntityResourceRoutes = ApiWorkspaceEntityRoutes["entity"];
type ApiEntityByIdRoutes = ApiEntityResourceRoutes[":entityId"];
type MemoriesRoutes = (typeof memoriesRoute)["~Routes"];
type EmptyElysia = Elysia;
type WebApiRoutes = Omit<ApiRoutes, "v1"> & {
  v1: Omit<ApiV1Routes, "entities" | "memories" | "time-entries"> & {
    entities: Omit<ApiEntityRoutes, ":workspaceId"> & {
      ":workspaceId": Omit<ApiWorkspaceEntityRoutes, "entity"> & {
        entity: Omit<ApiEntityResourceRoutes, ":entityId"> & {
          ":entityId": Omit<ApiEntityByIdRoutes, "ocr">;
        };
      };
    };
  };
};

/**
 * Main browser Eden surface. Routes whose addition would breach the recursive
 * type-cost budget use their own small, typed Eden client instead.
 */
export type WebAPI = Elysia<
  EmptyElysia["~Prefix"],
  EmptyElysia["~Singleton"],
  EmptyElysia["~Definitions"],
  EmptyElysia["~Metadata"],
  WebApiRoutes
>;

export type MemoriesAPI = Elysia<
  EmptyElysia["~Prefix"],
  EmptyElysia["~Singleton"],
  EmptyElysia["~Definitions"],
  EmptyElysia["~Metadata"],
  MemoriesRoutes
>;

// Types the browser reads by name. Each is re-exported from the API module that
// owns it, so apps/web imports the one definition instead of re-deriving it
// from a route's response or body.
export type { PositionDecisionSummary } from "@/api/lib/document-review/position-decisions";
export type { LegalListSourceLocator } from "@/api/lib/lists/types";
export type { GlobalSearchHit } from "@/api/lib/search/types";
export type {
  ViewLayout,
  ViewSort,
  ViewTemplateProperty,
} from "@/api/lib/views-schema";
export type { PositionSeverity } from "@/api/lib/workflow/playbook-position-facets";
export type {
  AskManual,
  DeterministicCheck,
  FallbackEntry,
  IdealLanguage,
  Negotiation,
  PlaybookScope,
  PlaybookTrigger,
  Position,
  PositionStandard,
  PositionStandardSource,
  ReferencePassage,
  TierRule,
} from "@/api/lib/workflow/playbook-positions";
export type { GradedPosition } from "@/api/lib/workflow/position-runtime";
