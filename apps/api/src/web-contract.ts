import type { apiRoutes } from "@/api/api-routes";
import type {
  ChatAnonRestoration,
  ChatClientTools,
  ChatMessage,
  ChatPart,
  ChatSourceDocument,
  ChatUITools,
} from "@/api/handlers/chat/types";
import type { RoutesOf } from "@/api/http/route";
import type { RouteTree } from "@/api/http/route-types";
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
import type { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch";

/**
 * Every route the API serves as the segment tree the browser client walks,
 * each path and method with its input and its answers by status. The local
 * development routes are in it too: the browser's Dev menu calls them in an
 * open runtime.
 */
type WebRoutes = RouteTree<RoutesOf<typeof apiRoutes>>;

/**
 * Every served route keeps its type: a group the compiler cannot read (a path
 * not declared as a literal, a group spread into an array) fails here, in the
 * API's own typecheck, instead of dropping out of the browser client.
 */
type UntypedRouteReasons = Extract<
  keyof RoutesOf<typeof apiRoutes>,
  `~routeTypeError: ${string}`
>;
true satisfies [UntypedRouteReasons] extends [never]
  ? true
  : UntypedRouteReasons;

// The local development groups load only in an open runtime; their routes are
// typed in every runtime (`servedIfLoaded`), as the Dev menu calls them.
true satisfies "/v1/dev/seed" | "/dev-public/last-otp" extends keyof RoutesOf<
  typeof apiRoutes
>
  ? true
  : never;

/**
 * Every API type apps/web consumes. apps/web never compiles the API: each
 * property is printed into apps/web/src/generated/api-routes.gen.ts by
 * apps/api/scripts/generate-web-api-types.ts, which also asserts the printed
 * types are identical to these.
 */
export type WebApiContract = {
  WebRoutes: WebRoutes;
  ChatAnonRestoration: ChatAnonRestoration;
  ChatClientTools: ChatClientTools;
  ChatMessage: ChatMessage;
  ChatPart: ChatPart;
  ChatSourceDocument: ChatSourceDocument;
  ChatUITools: ChatUITools;
  // Catalog capability ids, from the same generated records as MCP and the
  // CLI, so a browser write can only declare a capability that exists.
  CapabilityId: keyof typeof CAPABILITY_DISPATCH;
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
