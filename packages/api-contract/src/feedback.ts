/**
 * The feedback report contract, shared by the API, the web app and the MCP
 * tools. One report shape reaches every entry point: the authenticated web
 * route, the public intake, and the `submit_feedback` tool.
 *
 * Wire casing differs by transport and is mapped at the boundary: HTTP bodies
 * are camelCase (the shape below), MCP tool inputs are snake_case like every
 * other tool on that surface.
 */

export const FEEDBACK_KINDS = [
  "bug",
  "idea",
  "missing_capability",
  "docs",
] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** The part of the product a report is about; picked, never free text. */
export const FEEDBACK_AREAS = [
  "matters",
  "documents",
  "templates",
  "case_law",
  "legislation",
  "contacts",
  "tasks",
  "billing",
  "chat",
  "mcp_cli",
  "web_app",
  "desktop",
  "other",
] as const;

export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

/** Which client the report was written from. */
export const FEEDBACK_CLIENTS = [
  "mcp",
  "cli",
  "web",
  "desktop",
  "other",
] as const;

export type FeedbackClient = (typeof FEEDBACK_CLIENTS)[number];

/**
 * Which entry point a report came in through. Distinct from
 * `FeedbackClient`, which is what the reporter says they were using: `web` is
 * the authenticated route, `mcp` the agent tool, `intake` the public
 * unauthenticated receiver that carries no identity at all.
 */
export const FEEDBACK_VIAS = ["mcp", "web", "intake"] as const;

export type FeedbackVia = (typeof FEEDBACK_VIAS)[number];

/**
 * Per-field character caps. Every schema, description and reference resource
 * renders these rather than restating a number, so a cap cannot be promised in
 * one place and enforced as something else in another.
 */
export const FEEDBACK_LIMITS = {
  title: 200,
  whatHappened: 4000,
  expected: 2000,
  steps: 4000,
  evidence: 4000,
  contextField: 120,
} as const;

/**
 * Where the report came from, as the reporter saw it. Every string is
 * sanitized server-side except `requestId`, which is validated against a
 * narrow character class and stored verbatim: it is the lookup key a
 * maintainer needs, and the secret passes would otherwise eat it.
 */
export type FeedbackReportContext = {
  client?: FeedbackClient;
  clientVersion?: string;
  requestId?: string;
  route?: string;
  errorReference?: string;
};

export type FeedbackReportInput = {
  kind: FeedbackKind;
  area: FeedbackArea;
  title: string;
  whatHappened: string;
  expected?: string;
  steps?: string;
  evidence?: string;
  context?: FeedbackReportContext;
};

/** One delivery attempt's outcome. `url` is set only by a channel that has one. */
export type FeedbackDelivery = {
  channel: "email" | "github";
  status: "delivered" | "failed";
  url?: string;
};

/**
 * What every entry point answers with. `stored` is a literal: the report is
 * persisted before any delivery is attempted, so a receipt always addresses a
 * row even when no channel is configured.
 */
export type FeedbackSubmitResponse = {
  receipt: string;
  redactions: number;
  deduplicated: boolean;
  deliveries: FeedbackDelivery[];
  stored: true;
  /** Present only when the deployment has no delivery channel configured. */
  warning?: string;
};
