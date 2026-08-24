import {
  SIGNAL_ORIGIN,
  SIGNAL_SEVERITY,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";
import type {
  SignalOrigin,
  SignalSeverity,
  SuggestionKind,
} from "@stll/api-contract/signals";

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
  [SIGNAL_SEVERITY.CRITICAL]: "knowledge.playbooks.risk.riskLevel.critical",
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
  "manual.request": "inbox.scout.manualRequest",
  "infosoud.hearings": "workspaces.infosoud.title",
  "document.deadlines": "inbox.scout.documentDeadlines",
  "document.review": "inbox.scout.documentReview",
} as const satisfies Readonly<Record<string, TranslationKey>>;

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
