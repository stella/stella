import type { FeedbackArea, FeedbackKind } from "@stll/api-contract/feedback";

import type { TranslationKey } from "@/i18n/types";

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
