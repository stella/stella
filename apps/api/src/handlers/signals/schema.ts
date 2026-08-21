import { t } from "elysia";

import {
  SERVER_EXECUTED_SUGGESTION_KINDS,
  SIGNAL_ORIGINS,
  SIGNAL_SEVERITIES,
  SUGGESTION_KINDS,
} from "@stll/api-contract/signals";

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

const tUnion = <T extends readonly string[]>(values: T) =>
  t.Union(values.map((value) => t.Literal(value)));

export const listSignalsQuerySchema = t.Object({
  view: t.Optional(tUnion(SIGNAL_VIEWS)),
  matterId: t.Optional(tSafeId("workspace")),
  origin: t.Optional(tUnion(SIGNAL_ORIGINS)),
  severity: t.Optional(tUnion(SIGNAL_SEVERITIES)),
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
  severity: t.Optional(tUnion(SIGNAL_SEVERITIES)),
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
 * result here; client-resolved kinds report what the client produced (if
 * anything) so provenance survives either way.
 */
export const acceptBodySchema = t.Object({
  suggestionKind: tUnion(SUGGESTION_KINDS),
  result: t.Optional(
    t.Object({
      workspaceId: tSafeId("workspace"),
      entityId: tSafeId("entity"),
    }),
  ),
});

export const isServerExecutedSuggestionKind = (
  kind: (typeof SUGGESTION_KINDS)[number],
): kind is (typeof SERVER_EXECUTED_SUGGESTION_KINDS)[number] =>
  SERVER_EXECUTED_SUGGESTION_KINDS.some((k) => k === kind);
