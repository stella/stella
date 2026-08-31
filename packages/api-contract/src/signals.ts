/**
 * Inbox signals: typed observations produced by scouts (manual, external
 * source, or model) and consumed by the Inbox feed. Shared by API and web.
 *
 * Every signal carries its origin and, for model origin, a confidence plus
 * mandatory evidence, so a reader can tell a court-system date from a
 * model-read date at a glance.
 */

import type { WORK_OBLIGATION_STATUS } from "./workflow-status";

/** The two statuses a governed obligation is still open in. */
export type OpenWorkObligationStatus =
  | typeof WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT
  | typeof WORK_OBLIGATION_STATUS.ACTIVE;

export const SIGNAL_ORIGIN = {
  MANUAL: "manual",
  SOURCE: "source",
  MODEL: "model",
} as const;
export type SignalOrigin = (typeof SIGNAL_ORIGIN)[keyof typeof SIGNAL_ORIGIN];
export const SIGNAL_ORIGINS = [
  SIGNAL_ORIGIN.MANUAL,
  SIGNAL_ORIGIN.SOURCE,
  SIGNAL_ORIGIN.MODEL,
] as const satisfies readonly SignalOrigin[];

export const SIGNAL_SEVERITY = {
  INFO: "info",
  NOTICE: "notice",
  WARNING: "warning",
  CRITICAL: "critical",
} as const;
export type SignalSeverity =
  (typeof SIGNAL_SEVERITY)[keyof typeof SIGNAL_SEVERITY];
/** Ascending: index doubles as sort rank. */
export const SIGNAL_SEVERITIES = [
  SIGNAL_SEVERITY.INFO,
  SIGNAL_SEVERITY.NOTICE,
  SIGNAL_SEVERITY.WARNING,
  SIGNAL_SEVERITY.CRITICAL,
] as const satisfies readonly SignalSeverity[];

export const SIGNAL_STATUS = {
  NEW: "new",
  SNOOZED: "snoozed",
  ACCEPTED: "accepted",
  DISMISSED: "dismissed",
} as const;
export type SignalStatus = (typeof SIGNAL_STATUS)[keyof typeof SIGNAL_STATUS];
export const SIGNAL_STATUSES = [
  SIGNAL_STATUS.NEW,
  SIGNAL_STATUS.SNOOZED,
  SIGNAL_STATUS.ACCEPTED,
  SIGNAL_STATUS.DISMISSED,
] as const satisfies readonly SignalStatus[];

/** Which lifecycle slice the Inbox feed shows. */
export const SIGNAL_VIEW = {
  OPEN: "open",
  SNOOZED: "snoozed",
  RESOLVED: "resolved",
} as const;
export type SignalView = (typeof SIGNAL_VIEW)[keyof typeof SIGNAL_VIEW];
export const SIGNAL_VIEWS = [
  SIGNAL_VIEW.OPEN,
  SIGNAL_VIEW.SNOOZED,
  SIGNAL_VIEW.RESOLVED,
] as const satisfies readonly SignalView[];

/** Closed registry of signal producers shared by persistence and presentation. */
export const SCOUT_KEY = {
  MANUAL_REQUEST: "manual.request",
  INFOSOUD_HEARINGS: "infosoud.hearings",
  DOCUMENT_DEADLINES: "document.deadlines",
  DOCUMENT_REVIEW: "document.review",
  WORK_ATTENTION: "work.attention",
} as const;
export type ScoutKey = (typeof SCOUT_KEY)[keyof typeof SCOUT_KEY];

export const SIGNAL_KIND = {
  REQUEST_SUBMITTED: "request.submitted",
  HEARING_CHANGED: "hearing.changed",
  DEADLINE_DETECTED: "deadline.detected",
  CONTRACT_REVIEWED: "contract.reviewed",
  WORK_UNACKNOWLEDGED: "work.unacknowledged",
  WORK_DEADLINE_AT_RISK: "work.deadline_at_risk",
} as const;
export type SignalKind = (typeof SIGNAL_KIND)[keyof typeof SIGNAL_KIND];
export const SIGNAL_KINDS = [
  SIGNAL_KIND.REQUEST_SUBMITTED,
  SIGNAL_KIND.HEARING_CHANGED,
  SIGNAL_KIND.DEADLINE_DETECTED,
  SIGNAL_KIND.CONTRACT_REVIEWED,
  SIGNAL_KIND.WORK_UNACKNOWLEDGED,
  SIGNAL_KIND.WORK_DEADLINE_AT_RISK,
] as const satisfies readonly SignalKind[];

/** Each kind has exactly one origin; the map is total so a new kind must decide. */
export const SIGNAL_KIND_ORIGIN = {
  [SIGNAL_KIND.REQUEST_SUBMITTED]: SIGNAL_ORIGIN.MANUAL,
  [SIGNAL_KIND.HEARING_CHANGED]: SIGNAL_ORIGIN.SOURCE,
  [SIGNAL_KIND.DEADLINE_DETECTED]: SIGNAL_ORIGIN.MODEL,
  [SIGNAL_KIND.CONTRACT_REVIEWED]: SIGNAL_ORIGIN.MODEL,
  [SIGNAL_KIND.WORK_UNACKNOWLEDGED]: SIGNAL_ORIGIN.SOURCE,
  [SIGNAL_KIND.WORK_DEADLINE_AT_RISK]: SIGNAL_ORIGIN.SOURCE,
} as const satisfies Record<SignalKind, SignalOrigin>;

/** What a signal is about; rendered as the card's subject link. */
export type SignalSubject =
  | { type: "workspace"; workspaceId: string }
  | { type: "entity"; workspaceId: string; entityId: string }
  | { type: "court-case"; courtCode: string; caseNumber: string }
  | { type: "none" };

export type SignalAttachment = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
};

/** Kind-specific facts behind a signal; mandatory for model origin. */
export type SignalEvidence =
  | {
      kind: typeof SIGNAL_KIND.REQUEST_SUBMITTED;
      description: string;
      attachments: SignalAttachment[];
    }
  | {
      kind: typeof SIGNAL_KIND.HEARING_CHANGED;
      courtName: string;
      caseNumber: string;
      previousAt: string | null;
      currentAt: string;
      hearingType: string | null;
      sourceUrl: string | null;
    }
  | {
      kind: typeof SIGNAL_KIND.DEADLINE_DETECTED;
      dueAt: string;
      label: string;
      quote: string;
      entityId: string;
      entityName: string;
    }
  | {
      kind: typeof SIGNAL_KIND.CONTRACT_REVIEWED;
      entityId: string;
      entityName: string;
      verdict: "safe" | "needs-review" | "reject";
      findings: { title: string; severity: SignalSeverity; quote: string }[];
      reviewRunId: string | null;
    }
  | {
      kind: typeof SIGNAL_KIND.WORK_UNACKNOWLEDGED;
      obligationEntityId: string;
      ownerUserId: string;
      /** When the current owner was put on the obligation. */
      assignedAt: string;
      daysWaiting: number;
      workingTargetDate: string | null;
      hardDeadlineDate: string | null;
    }
  | {
      kind: typeof SIGNAL_KIND.WORK_DEADLINE_AT_RISK;
      obligationEntityId: string;
      ownerUserId: string;
      hardDeadlineDate: string;
      workingTargetDate: string | null;
      /** Negative once the deadline has passed; severity carries the same split. */
      daysUntilDeadline: number;
      obligationStatus: OpenWorkObligationStatus;
    };

type MissingEvidenceKind = Exclude<SignalKind, SignalEvidence["kind"]>;
type ExtraEvidenceKind = Exclude<SignalEvidence["kind"], SignalKind>;
true satisfies [MissingEvidenceKind, ExtraEvidenceKind] extends [never, never]
  ? true
  : never;

export const SUGGESTION_KIND = {
  CREATE_DEADLINE: "create-deadline",
  CREATE_TASK: "create-task",
  PROMOTE_TO_WORKSPACE: "promote-to-workspace",
  ASSIGN: "assign",
  OPEN_CHAT: "open-chat",
} as const;
export type SuggestionKind =
  (typeof SUGGESTION_KIND)[keyof typeof SUGGESTION_KIND];
export const SUGGESTION_KINDS = [
  SUGGESTION_KIND.CREATE_DEADLINE,
  SUGGESTION_KIND.CREATE_TASK,
  SUGGESTION_KIND.PROMOTE_TO_WORKSPACE,
  SUGGESTION_KIND.ASSIGN,
  SUGGESTION_KIND.OPEN_CHAT,
] as const satisfies readonly SuggestionKind[];

/**
 * A proposed action. Every kind maps to an existing Stella operation; the
 * server executes it on accept, never on emit. `open-chat` and the
 * workspace-picking kinds are resolved client-side (they need user input).
 */
export type SignalSuggestion =
  | {
      kind: typeof SUGGESTION_KIND.CREATE_DEADLINE;
      workspaceId: string;
      name: string;
      dueAt: string;
    }
  | {
      kind: typeof SUGGESTION_KIND.CREATE_TASK;
      workspaceId: string;
      name: string;
      dueAt: string | null;
    }
  | { kind: typeof SUGGESTION_KIND.PROMOTE_TO_WORKSPACE }
  | { kind: typeof SUGGESTION_KIND.ASSIGN }
  | { kind: typeof SUGGESTION_KIND.OPEN_CHAT; prompt: string };

type MissingSuggestionKind = Exclude<SuggestionKind, SignalSuggestion["kind"]>;
type ExtraSuggestionKind = Exclude<SignalSuggestion["kind"], SuggestionKind>;
true satisfies [MissingSuggestionKind, ExtraSuggestionKind] extends [
  never,
  never,
]
  ? true
  : never;

/** Suggestions executed server-side on accept; the rest resolve client-side. */
export const SERVER_EXECUTED_SUGGESTION_KINDS = [
  SUGGESTION_KIND.CREATE_DEADLINE,
  SUGGESTION_KIND.CREATE_TASK,
] as const satisfies readonly SuggestionKind[];
export type ServerExecutedSuggestionKind =
  (typeof SERVER_EXECUTED_SUGGESTION_KINDS)[number];

export const isSignalStatus = (value: unknown): value is SignalStatus =>
  typeof value === "string" && SIGNAL_STATUSES.some((s) => s === value);
export const isSignalOrigin = (value: unknown): value is SignalOrigin =>
  typeof value === "string" && SIGNAL_ORIGINS.some((s) => s === value);
export const isSignalSeverity = (value: unknown): value is SignalSeverity =>
  typeof value === "string" && SIGNAL_SEVERITIES.some((s) => s === value);
export const isSignalKind = (value: unknown): value is SignalKind =>
  typeof value === "string" && SIGNAL_KINDS.some((s) => s === value);
