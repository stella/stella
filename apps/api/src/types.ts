import type Elysia from "elysia";

import type { properties } from "@/api/db/schema";
import type * as SchemaValidators from "@/api/db/schema-validators";
import type { memoriesRoute } from "@/api/handlers/memories/routes";
import type * as ViewSchemas from "@/api/lib/views-schema";
import type api from "@/api/server.js";

export type API = typeof api;

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

export type { SafeId, SafeIdType } from "@/api/lib/branded-types";
export type { LegalListSourceLocator } from "@/api/lib/lists/types";
export type { Page } from "@/api/lib/pagination";
export type { SavedSearchCriteria } from "@/api/lib/saved-searches";
export type { UpsertFieldContent } from "@/api/handlers/fields/upsert-by-id";

export type PropertyTable = typeof properties.$inferSelect;
export type PropertyContent = SchemaValidators.PropertyContent;
export type PropertyContentType = SchemaValidators.PropertyContentType;
export type PlaybookBundleColumn = SchemaValidators.PlaybookBundleColumn;
export type PlaybookBundle = SchemaValidators.PlaybookBundle;

export type FieldContent = SchemaValidators.FieldContent;

export type OptionColor = SchemaValidators.OptionColor;

export type BoundingBox = SchemaValidators.BoundingBoxes["boxes"][number];

export type EntityKind = SchemaValidators.EntityKind;
export type {
  AgendaItemKind,
  AgendaItemSource,
} from "@/api/lib/entity-constants";
export type {
  GlobalSearchHit,
  GlobalSearchResultType,
} from "@/api/lib/search/types";

export type {
  ChatAnonRestoration,
  ChatAnonRestorationsData,
  ChatMention,
  ChatMentionCategory,
  ChatMentionHref,
  ChatMentionHrefPrefix,
  ChatMentionHrefPrefixMap,
  ChatMessage,
  ChatPart,
  ChatReferenceCategory,
  ChatReferenceHrefPrefix,
  ChatUserFileUrl,
  ChatUITools,
} from "@/api/handlers/chat/types";
export type ViewLayout = ViewSchemas.ViewLayout;
export type ViewLayoutType = ViewSchemas.ViewLayoutType;
export type ViewTemplateProperty = ViewSchemas.ViewTemplateProperty;
export type { ConditionNode } from "@stll/conditions";
export type { ChatMentionsData } from "@/api/handlers/chat/types";
export type { TemplateRecipeDefinition } from "@/api/handlers/template-recipes/definition";
export type { ChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
export type {
  ApprovalRequiredBuiltInChatToolName,
  BuiltInChatToolPolicyKindByName,
} from "@/api/handlers/chat/tools/chat-tools";
export type { UserFileUrl } from "@/api/lib/user-files/types";
export type { McpOAuthScope } from "@/api/mcp/constants";
