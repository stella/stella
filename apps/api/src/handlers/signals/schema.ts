import type { TSchema } from "@sinclair/typebox";
import { t } from "elysia";

import {
  SERVER_EXECUTED_SUGGESTION_KINDS,
  SIGNAL_ORIGIN,
  SIGNAL_SEVERITY,
  SUGGESTION_KINDS,
} from "@stll/api-contract/signals";
import type { SignalOrigin, SignalSeverity } from "@stll/api-contract/signals";

import {
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
} from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

/** Which slice of the lifecycle the feed shows. */
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

const SIGNAL_VIEW_SCHEMAS = {
  [SIGNAL_VIEW.OPEN]: t.Literal(SIGNAL_VIEW.OPEN),
  [SIGNAL_VIEW.SNOOZED]: t.Literal(SIGNAL_VIEW.SNOOZED),
  [SIGNAL_VIEW.RESOLVED]: t.Literal(SIGNAL_VIEW.RESOLVED),
} as const satisfies Record<SignalView, TSchema>;
const signalViewSchema = t.Union([
  SIGNAL_VIEW_SCHEMAS.open,
  SIGNAL_VIEW_SCHEMAS.snoozed,
  SIGNAL_VIEW_SCHEMAS.resolved,
]);

const SIGNAL_ORIGIN_SCHEMAS = {
  [SIGNAL_ORIGIN.MANUAL]: t.Literal(SIGNAL_ORIGIN.MANUAL),
  [SIGNAL_ORIGIN.SOURCE]: t.Literal(SIGNAL_ORIGIN.SOURCE),
  [SIGNAL_ORIGIN.MODEL]: t.Literal(SIGNAL_ORIGIN.MODEL),
} as const satisfies Record<SignalOrigin, TSchema>;
const signalOriginSchema = t.Union([
  SIGNAL_ORIGIN_SCHEMAS.manual,
  SIGNAL_ORIGIN_SCHEMAS.source,
  SIGNAL_ORIGIN_SCHEMAS.model,
]);

const SIGNAL_SEVERITY_SCHEMAS = {
  [SIGNAL_SEVERITY.INFO]: t.Literal(SIGNAL_SEVERITY.INFO),
  [SIGNAL_SEVERITY.NOTICE]: t.Literal(SIGNAL_SEVERITY.NOTICE),
  [SIGNAL_SEVERITY.WARNING]: t.Literal(SIGNAL_SEVERITY.WARNING),
  [SIGNAL_SEVERITY.CRITICAL]: t.Literal(SIGNAL_SEVERITY.CRITICAL),
} as const satisfies Record<SignalSeverity, TSchema>;
const signalSeveritySchema = t.Union([
  SIGNAL_SEVERITY_SCHEMAS.info,
  SIGNAL_SEVERITY_SCHEMAS.notice,
  SIGNAL_SEVERITY_SCHEMAS.warning,
  SIGNAL_SEVERITY_SCHEMAS.critical,
]);
const suggestionKindSchema = t.UnionEnum(SUGGESTION_KINDS);

export const listSignalsQuerySchema = t.Object({
  view: t.Optional(signalViewSchema),
  matterId: t.Optional(tSafeId("workspace")),
  origin: t.Optional(signalOriginSchema),
  severity: t.Optional(signalSeveritySchema),
  assignedToMe: t.Optional(t.Boolean()),
  limit: t.Optional(tPaginationLimit(LIMITS.signalsPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
});

export const signalParamsSchema = t.Object({ signalId: tSafeId("signal") });

export const createRequestBodySchema = t.Object({
  title: t.String({ minLength: 1, maxLength: 512 }),
  description: t.String({ maxLength: 10_000 }),
  matterId: t.Optional(t.Nullable(tSafeId("workspace"))),
  assigneeUserId: t.Optional(t.Nullable(tSafeId("user"))),
  severity: t.Optional(signalSeveritySchema),
});

export const snoozeBodySchema = t.Object({
  until: t.String({ format: "date-time" }),
});

export const dismissBodySchema = t.Object({
  reason: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
});

export const assignBodySchema = t.Object({
  assigneeUserId: t.Nullable(tSafeId("user")),
});

/**
 * Accepting names the suggestion taken. Server-executed kinds create the
 * result here; promotion reports the matter created by the client so
 * provenance survives the dialog boundary.
 */
export const acceptBodySchema = t.Object({
  suggestionKind: suggestionKindSchema,
  result: t.Optional(
    t.Object({
      type: t.Literal("workspace"),
      workspaceId: tSafeId("workspace"),
    }),
  ),
});

export const isServerExecutedSuggestionKind = (
  kind: (typeof SUGGESTION_KINDS)[number],
): kind is (typeof SERVER_EXECUTED_SUGGESTION_KINDS)[number] =>
  SERVER_EXECUTED_SUGGESTION_KINDS.some((k) => k === kind);
