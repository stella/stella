import type {
  ChatAnonRestoration,
  ChatMessage,
  ChatPart,
  ChatSourceDocument,
  ChatUITools,
} from "@/api/handlers/chat/types";
import type { memoriesRoute } from "@/api/handlers/memories/routes";
import type { PositionDecisionSummary } from "@/api/lib/document-review/position-decisions";
import type { LegalListSourceLocator } from "@/api/lib/lists/types";
import type { GlobalSearchHit } from "@/api/lib/search/types";
import type {
  ViewLayout,
  ViewSort,
  ViewTemplateProperty,
} from "@/api/lib/views-schema";
import type { PositionSeverity } from "@/api/lib/workflow/playbook-position-facets";
import type {
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
import type { GradedPosition } from "@/api/lib/workflow/position-runtime";
import type api from "@/api/server.js";

type ApiRoutes = (typeof api)["~Routes"];
type ApiV1Routes = ApiRoutes["v1"];
type ApiEntityRoutes = ApiV1Routes["entities"];
type ApiWorkspaceEntityRoutes = ApiEntityRoutes[":workspaceId"];
type ApiEntityResourceRoutes = ApiWorkspaceEntityRoutes["entity"];
type ApiEntityByIdRoutes = ApiEntityResourceRoutes[":entityId"];

/**
 * Main browser Eden route tree. Routes whose addition would breach the
 * recursive type-cost budget use their own small, typed Eden client instead.
 */
type WebRoutes = Omit<ApiRoutes, "v1"> & {
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
 * Every API type apps/web consumes. apps/web never compiles the API: each
 * property is printed into apps/web/src/generated/api-routes.gen.ts by
 * apps/api/scripts/generate-web-api-types.ts, which also asserts the printed
 * types are identical to these.
 */
export type WebApiContract = {
  WebRoutes: WebRoutes;
  MemoriesRoutes: (typeof memoriesRoute)["~Routes"];
  ChatAnonRestoration: ChatAnonRestoration;
  ChatMessage: ChatMessage;
  ChatPart: ChatPart;
  ChatSourceDocument: ChatSourceDocument;
  ChatUITools: ChatUITools;
  // Types the API owns and the browser reads by name, so apps/web imports the
  // one definition instead of re-deriving it from a route's response or body.
  AskManual: AskManual;
  DeterministicCheck: DeterministicCheck;
  FallbackEntry: FallbackEntry;
  GlobalSearchHit: GlobalSearchHit;
  GradedPosition: GradedPosition;
  IdealLanguage: IdealLanguage;
  LegalListSourceLocator: LegalListSourceLocator;
  Negotiation: Negotiation;
  PlaybookScope: PlaybookScope;
  PlaybookTrigger: PlaybookTrigger;
  Position: Position;
  PositionDecisionSummary: PositionDecisionSummary;
  PositionSeverity: PositionSeverity;
  PositionStandard: PositionStandard;
  PositionStandardSource: PositionStandardSource;
  ReferencePassage: ReferencePassage;
  TierRule: TierRule;
  ViewLayout: ViewLayout;
  ViewSort: ViewSort;
  ViewTemplateProperty: ViewTemplateProperty;
};
