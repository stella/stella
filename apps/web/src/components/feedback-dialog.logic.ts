import { panic } from "better-result";
import * as v from "valibot";

import type {
  FeedbackArea,
  FeedbackKind,
  FeedbackSubmitResponse,
} from "@stll/api-contract/feedback";

import type { ClientAuthStatus } from "@/hooks/use-client-auth-status";
import type { TranslationKey } from "@/i18n/types";
import type { ErrorReference } from "@/lib/analytics/error-reference";

/**
 * Which route a report is filed through. `account` is `POST /v1/feedback`,
 * which needs a signed-in member; `public` is the unauthenticated
 * `POST /public/feedback` intake, bounded by strict validation and a per-IP
 * rate limit instead of identity.
 */
export const FEEDBACK_CHANNELS = {
  account: "account",
  public: "public",
} as const;

export type FeedbackChannel =
  (typeof FEEDBACK_CHANNELS)[keyof typeof FEEDBACK_CHANNELS];

/** The channel for a session state, or `null` while the session is unknown
 *  (still resolving, or the read failed): guessing would file a member's
 *  report anonymously, so only a confirmed visitor gets the public intake. */
export const resolveFeedbackChannel = (
  session: ClientAuthStatus["status"],
): FeedbackChannel | null => {
  switch (session) {
    case "authenticated":
      return FEEDBACK_CHANNELS.account;
    case "anonymous":
      return FEEDBACK_CHANNELS.public;
    case "checking":
    case "unavailable":
      return null;
    default:
      session satisfies never;
      return panic(`Unhandled session status: ${String(session)}`);
  }
};

type FeedbackRequestBodyOptions = {
  clientVersion: string;
  errorReference: ErrorReference | undefined;
  report: {
    area: FeedbackArea;
    kind: FeedbackKind;
    steps: string;
    title: string;
    whatHappened: string;
  };
  route: string;
};

/**
 * The body both channels accept. The public intake rejects unknown keys, so
 * an empty optional field is omitted rather than sent as `""`.
 */
export const buildFeedbackRequestBody = ({
  clientVersion,
  errorReference,
  report,
  route,
}: FeedbackRequestBodyOptions) => ({
  area: report.area,
  kind: report.kind,
  title: report.title,
  whatHappened: report.whatHappened,
  ...(report.steps.length > 0 && { steps: report.steps }),
  context: {
    client: "web" as const,
    clientVersion,
    route,
    ...(errorReference !== undefined && { errorReference }),
  },
});

/** The part of a submit response the receipt screen shows. */
export type FeedbackReceiptView = Pick<
  FeedbackSubmitResponse,
  "deduplicated" | "receipt" | "warning"
>;

/**
 * The public intake answers with a hand-built `Response`, so Eden cannot type
 * its body; the receipt is validated here rather than trusted.
 */
export const feedbackReceiptSchema = v.object({
  deduplicated: v.boolean(),
  receipt: v.pipe(v.string(), v.nonEmpty()),
  warning: v.exactOptional(v.string()),
}) satisfies v.GenericSchema<unknown, FeedbackReceiptView>;

export const FEEDBACK_FALLBACK_AREA = "other" as const satisfies FeedbackArea;
export const FEEDBACK_DEFAULT_KIND = "bug" as const satisfies FeedbackKind;

/** Path patterns keyed to the area a report from that surface belongs to.
 *  `*` matches exactly one path segment, so matter and country ids need no
 *  entry of their own. The longest matching pattern wins, which keeps the
 *  result independent of declaration order. */
export const ROUTE_AREA_PATTERNS = {
  "/chat": "chat",
  "/contacts": "contacts",
  "/inbox": "tasks",
  "/knowledge": "templates",
  "/law": "legislation",
  "/law/cases": "case_law",
  "/law/*/cases": "case_law",
  "/mcp": "mcp_cli",
  "/onboarding": "web_app",
  "/settings": "web_app",
  "/settings/account/desktop": "desktop",
  "/tools": "web_app",
  "/workspaces": "matters",
  "/workspaces/*/expenses": "billing",
  "/workspaces/*/invoices": "billing",
  "/workspaces/*/reports": "billing",
  "/workspaces/*/timesheets": "billing",
  "/workspaces/*/*/document": "documents",
} as const satisfies Record<string, FeedbackArea>;

const SEGMENT_WILDCARD = "*";

const toSegments = (path: string): string[] =>
  path.split("/").filter((segment) => segment.length > 0);

const matchesPrefix = (
  patternSegments: string[],
  pathSegments: string[],
): boolean =>
  patternSegments.length <= pathSegments.length &&
  patternSegments.every(
    (segment, index) =>
      segment === SEGMENT_WILDCARD || segment === pathSegments[index],
  );

/** Pick the area a report opened on `pathname` is about. Unknown routes stay
 *  `other` rather than guessing, so a wrong area never looks deliberate. */
export const resolveFeedbackArea = (pathname: string): FeedbackArea => {
  const pathSegments = toSegments(pathname);
  let matched: { area: FeedbackArea; depth: number } | null = null;

  for (const [pattern, area] of Object.entries(ROUTE_AREA_PATTERNS)) {
    const patternSegments = toSegments(pattern);
    if (!matchesPrefix(patternSegments, pathSegments)) {
      continue;
    }
    if (matched === null || patternSegments.length > matched.depth) {
      matched = { area, depth: patternSegments.length };
    }
  }

  return matched?.area ?? FEEDBACK_FALLBACK_AREA;
};

export const FEEDBACK_KIND_LABEL_KEYS = {
  bug: "feedback.kinds.bug",
  idea: "feedback.kinds.idea",
  missing_capability: "feedback.kinds.missingCapability",
  docs: "common.documentation",
} as const satisfies Record<FeedbackKind, TranslationKey>;

export const FEEDBACK_AREA_LABEL_KEYS = {
  matters: "common.matters",
  documents: "common.documents",
  templates: "navigation.templates",
  case_law: "common.caseLaw",
  legislation: "feedback.areas.legislation",
  contacts: "navigation.contacts",
  tasks: "tasks.title",
  billing: "common.timeBilling",
  chat: "navigation.chat",
  mcp_cli: "feedback.areas.mcpCli",
  web_app: "feedback.areas.webApp",
  desktop: "feedback.areas.desktop",
  other: "feedback.areas.other",
} as const satisfies Record<FeedbackArea, TranslationKey>;
