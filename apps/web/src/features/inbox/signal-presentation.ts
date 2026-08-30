import {
  SIGNAL_ORIGIN,
  SIGNAL_SEVERITY,
  SCOUT_KEY,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";
import type {
  OpenWorkObligationStatus,
  SignalOrigin,
  SignalSeverity,
  ScoutKey,
  SuggestionKind,
} from "@stll/api-contract/signals";
import { WORK_OBLIGATION_STATUS } from "@stll/api-contract/workflow-status";

import type { TranslationKey } from "@/i18n/types";

export const SEVERITY_DOT_CLASS = {
  [SIGNAL_SEVERITY.INFO]: "bg-foreground-placeholder",
  [SIGNAL_SEVERITY.NOTICE]: "bg-foreground-strong-muted",
  [SIGNAL_SEVERITY.WARNING]: "bg-warning",
  [SIGNAL_SEVERITY.CRITICAL]: "bg-destructive",
} as const satisfies Record<SignalSeverity, string>;

export const SEVERITY_LABEL_KEY = {
  [SIGNAL_SEVERITY.INFO]: "inbox.severity.info",
  [SIGNAL_SEVERITY.NOTICE]: "inbox.severity.notice",
  [SIGNAL_SEVERITY.WARNING]: "inbox.severity.warning",
  [SIGNAL_SEVERITY.CRITICAL]: "inbox.severity.critical",
} as const satisfies Record<SignalSeverity, TranslationKey>;

export const ORIGIN_LABEL_KEY = {
  [SIGNAL_ORIGIN.MANUAL]: "inbox.origin.manual",
  [SIGNAL_ORIGIN.SOURCE]: "inbox.origin.source",
  [SIGNAL_ORIGIN.MODEL]: "inbox.origin.model",
} as const satisfies Record<SignalOrigin, TranslationKey>;

export const SUGGESTION_LABEL_KEY = {
  [SUGGESTION_KIND.CREATE_DEADLINE]: "inbox.suggestion.createDeadline",
  [SUGGESTION_KIND.CREATE_TASK]: "inbox.suggestion.createTask",
  [SUGGESTION_KIND.PROMOTE_TO_WORKSPACE]: "common.newMatter",
  [SUGGESTION_KIND.ASSIGN]: "inbox.suggestion.assign",
  [SUGGESTION_KIND.OPEN_CHAT]: "inspector.openChat",
} as const satisfies Record<SuggestionKind, TranslationKey>;

/**
 * Display names for source-origin producers. Keys are server-defined, so
 * this is a display lookup with the raw key as the fallback, not a total
 * map.
 */
const SCOUT_LABEL_KEY = {
  [SCOUT_KEY.MANUAL_REQUEST]: "inbox.scout.manualRequest",
  [SCOUT_KEY.INFOSOUD_HEARINGS]: "workspaces.infosoud.title",
  [SCOUT_KEY.DOCUMENT_DEADLINES]: "inbox.scout.documentDeadlines",
  [SCOUT_KEY.DOCUMENT_REVIEW]: "inbox.scout.documentReview",
  [SCOUT_KEY.WORK_ATTENTION]: "inbox.scout.workAttention",
} as const satisfies Readonly<Record<ScoutKey, TranslationKey>>;

/** The statuses work-attention evidence can report; closed work emits none. */
export const OPEN_WORK_STATUS_LABEL_KEY = {
  [WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT]:
    "tasks.queue.toAcknowledge",
  [WORK_OBLIGATION_STATUS.ACTIVE]: "common.active",
} as const satisfies Record<OpenWorkObligationStatus, TranslationKey>;

type KnownScoutKey = keyof typeof SCOUT_LABEL_KEY;
type ScoutLabelKey = (typeof SCOUT_LABEL_KEY)[KnownScoutKey];

const isKnownScoutKey = (scoutKey: string): scoutKey is KnownScoutKey =>
  Object.hasOwn(SCOUT_LABEL_KEY, scoutKey);

export const scoutLabelKey = (scoutKey: string): ScoutLabelKey | null =>
  isKnownScoutKey(scoutKey) ? SCOUT_LABEL_KEY[scoutKey] : null;

export const VERDICT_LABEL_KEY = {
  safe: "inbox.verdict.safe",
  "needs-review": "workspaces.table.flags.needsReview",
  reject: "docxReview.reject",
} as const satisfies Record<"safe" | "needs-review" | "reject", TranslationKey>;
