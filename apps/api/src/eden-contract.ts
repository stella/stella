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
