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
  PropertyContentType,
  SafeId,
  SafeIdType,
  SavedSearchCriteria,
  TemplateRecipeDefinition,
  ViewLayoutType,
} from "@stll/api-contract";
import type { ConditionNode } from "@stll/conditions";
import type { OptionColor } from "@stll/ui/option-color";

import type {
  ChatAnonRestoration,
  ChatMessage,
  ChatPart,
  ChatSourceDocument,
  ChatUITools,
} from "@/api/handlers/chat/types";
import type {
  GlobalSearchHit,
  LegalListSourceLocator,
  ViewLayout,
  ViewTemplateProperty,
  WebApiRoutes,
} from "@/lib/eden-client";

type PropertiesResponse =
  WebApiRoutes["properties"][":workspaceId"]["get"]["response"][200];

// The wire shape of one property list item, straight off the Eden response.
// `WorkspaceProperty` in `@/lib/types` derives from this so a column the API
// starts or stops projecting shows up there as a type error instead of
// silently drifting.
export type WorkspacePropertyWire = PropertiesResponse[number];
export type PropertyContent = PropertiesResponse[number]["content"];
export type UpsertFieldContent =
  WebApiRoutes["fields"][":workspaceId"]["post"]["body"]["content"];
export type BoundingBox =
  WebApiRoutes["workspaces"][":workspaceId"]["bounding-boxes"]["post"]["response"][200]["boxes"][number];
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
  GlobalSearchHit,
  GlobalSearchResultType,
  LegalListSourceLocator,
  McpOAuthScope,
  OptionColor,
  PropertyContentType,
  SafeId,
  SafeIdType,
  SavedSearchCriteria,
  TemplateRecipeDefinition,
  ViewLayout,
  ViewLayoutType,
  ViewTemplateProperty,
};
export { MCP_CHAT_TOOL_GRANT_POLICIES } from "@stll/api-contract";
