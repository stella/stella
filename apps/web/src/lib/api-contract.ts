import type {
  ApprovalRequiredBuiltInChatToolName,
  BuiltInChatToolPolicyKindByName,
  ChatMentionCategory,
  EntityKind,
  GlobalSearchResultType,
  McpOAuthScope,
  PropertyContentType,
  SafeId,
  SavedSearchCriteria,
  TemplateRecipeDefinition,
  ViewLayoutType,
} from "@stll/api-contract";
import type { ConditionNode } from "@stll/conditions";

import type {
  AskManual,
  CapabilityId,
  ChatAnonRestoration,
  ChatClientTools,
  ChatMessage,
  ChatPart,
  ChatSourceDocument,
  ChatUITools,
  DeterministicCheck,
  FallbackEntry,
  GlobalSearchHit,
  GradedPosition,
  IdealLanguage,
  LegalListSourceLocator,
  Negotiation,
  PlaybookScope,
  PlaybookTrigger,
  Position,
  PositionDecisionSummary,
  PositionSeverity,
  PositionStandard,
  ReferencePassage,
  TierRule,
  ViewLayout,
  ViewSort,
  ViewTemplateProperty,
  WebRoutes,
} from "@/generated/api-routes.gen";

export type WebApiRoutes = WebRoutes["v1"];

type PropertiesResponse =
  WebApiRoutes["properties"][":workspaceId"]["get"]["response"][200];

// The wire shape of one property list item, straight off the API response.
// `WorkspaceProperty` in `@/lib/types` derives from this so a column the API
// starts or stops projecting shows up there as a type error instead of
// silently drifting.
export type WorkspacePropertyWire = PropertiesResponse[number];
type PropertyContent = PropertiesResponse[number]["content"];
export type PropertyOptionColor = Extract<
  PropertyContent,
  { type: "multi-select" | "single-select" }
>["options"][number]["color"];
/** A value to write; the route also takes `null`, which clears the cell. */
export type UpsertFieldContent = NonNullable<
  WebApiRoutes["fields"][":workspaceId"]["post"]["body"]["content"]
>;
export type BoundingBox =
  WebApiRoutes["workspaces"][":workspaceId"]["bounding-boxes"]["post"]["response"][200]["boxes"][number];
export type {
  ApprovalRequiredBuiltInChatToolName,
  AskManual,
  BuiltInChatToolPolicyKindByName,
  CapabilityId,
  ChatAnonRestoration,
  ChatClientTools,
  ChatMentionCategory,
  ChatMessage,
  ChatPart,
  ChatSourceDocument,
  ChatUITools,
  ConditionNode,
  DeterministicCheck,
  EntityKind,
  FallbackEntry,
  GlobalSearchHit,
  GlobalSearchResultType,
  GradedPosition,
  IdealLanguage,
  LegalListSourceLocator,
  McpOAuthScope,
  Negotiation,
  PlaybookScope,
  PlaybookTrigger,
  Position,
  PositionDecisionSummary,
  PositionSeverity,
  PositionStandard,
  PropertyContentType,
  ReferencePassage,
  SafeId,
  SavedSearchCriteria,
  TemplateRecipeDefinition,
  TierRule,
  ViewLayout,
  ViewLayoutType,
  ViewSort,
  ViewTemplateProperty,
};
export { MCP_CHAT_TOOL_GRANT_POLICIES } from "@stll/api-contract";
