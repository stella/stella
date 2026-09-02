import type {
  AgendaItemKind,
  AgendaItemSource,
  ApprovalRequiredBuiltInChatToolName,
  BuiltInChatToolPolicyKindByName,
  ChatMentionCategory,
  ChatMentionHrefPrefixMap,
  EntityKind,
  GlobalSearchResultType,
  McpOAuthScope,
  SafeId,
  SafeIdType,
  SavedSearchCriteria,
  TemplateRecipeDefinition,
  ViewLayoutType,
} from "@stll/api-contract";
import type { ConditionNode } from "@stll/conditions";

import type {
  ChatAnonRestoration,
  ChatMessage,
  ChatPart,
  ChatSourceDocument,
  ChatUITools,
} from "@/api/handlers/chat/types";
import type { WebApiRoutes } from "@/lib/eden-client";

type SearchResponse = WebApiRoutes["search"]["post"]["response"][200];
type LegalListSourcesResponse =
  WebApiRoutes["lists"][":workspaceId"][":listId"]["items"][":itemEntityId"]["sources"]["get"]["response"][200];
type PropertiesResponse =
  WebApiRoutes["properties"][":workspaceId"]["get"]["response"][200];
type ViewTemplatesResponse =
  WebApiRoutes["view-templates"][":workspaceId"]["get"]["response"][200];

export type GlobalSearchHit = SearchResponse["hits"][number];
// The wire shape of one property list item, straight off the Eden response.
// `WorkspaceProperty` in `@/lib/types` derives from this so a column the API
// starts or stops projecting shows up there as a type error instead of
// silently drifting.
export type WorkspacePropertyWire = PropertiesResponse[number];
export type PropertyContent = PropertiesResponse[number]["content"];
export type PropertyContentType = PropertyContent["type"];
export type OptionColor = Extract<
  PropertyContent,
  { type: "multi-select" | "single-select" }
>["options"][number]["color"];
export type UpsertFieldContent =
  WebApiRoutes["fields"][":workspaceId"]["post"]["body"]["content"];
export type BoundingBox =
  WebApiRoutes["workspaces"][":workspaceId"]["bounding-boxes"]["post"]["response"][200]["boxes"][number];
export type ViewLayout =
  WebApiRoutes["views"][":workspaceId"]["put"]["body"]["layout"];
export type ViewTemplateProperty = NonNullable<
  ViewTemplatesResponse[number]["templateProperties"]
>[number];
export type LegalListSourceLocator =
  LegalListSourcesResponse["items"][number]["locator"];
export type {
  AgendaItemKind,
  AgendaItemSource,
  ApprovalRequiredBuiltInChatToolName,
  BuiltInChatToolPolicyKindByName,
  ChatAnonRestoration,
  ChatMessage,
  ChatMentionCategory,
  ChatMentionHrefPrefixMap,
  ChatPart,
  ChatSourceDocument,
  ChatUITools,
  ConditionNode,
  EntityKind,
  GlobalSearchResultType,
  McpOAuthScope,
  SafeId,
  SafeIdType,
  SavedSearchCriteria,
  TemplateRecipeDefinition,
  ViewLayoutType,
};
