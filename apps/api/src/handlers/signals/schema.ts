import * as v from "valibot";

import { apiDateTimeSchema } from "@stll/api-contract/api-date";
import {
  booleanFromString,
  numberFromString,
} from "@stll/api-contract/http-input";
import {
  SIGNAL_ORIGIN,
  SIGNAL_SEVERITY,
  SUGGESTION_KINDS,
} from "@stll/api-contract/signals";
import type { SignalOrigin, SignalSeverity } from "@stll/api-contract/signals";

import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { signalViewSchema } from "@/api/lib/signals/view-schema";

const SIGNAL_ORIGIN_SCHEMAS = {
  [SIGNAL_ORIGIN.MANUAL]: v.literal(SIGNAL_ORIGIN.MANUAL),
  [SIGNAL_ORIGIN.SOURCE]: v.literal(SIGNAL_ORIGIN.SOURCE),
  [SIGNAL_ORIGIN.MODEL]: v.literal(SIGNAL_ORIGIN.MODEL),
} as const satisfies Record<SignalOrigin, v.GenericSchema>;
const signalOriginSchema = v.union([
  SIGNAL_ORIGIN_SCHEMAS.manual,
  SIGNAL_ORIGIN_SCHEMAS.source,
  SIGNAL_ORIGIN_SCHEMAS.model,
]);

const SIGNAL_SEVERITY_SCHEMAS = {
  [SIGNAL_SEVERITY.INFO]: v.literal(SIGNAL_SEVERITY.INFO),
  [SIGNAL_SEVERITY.NOTICE]: v.literal(SIGNAL_SEVERITY.NOTICE),
  [SIGNAL_SEVERITY.WARNING]: v.literal(SIGNAL_SEVERITY.WARNING),
  [SIGNAL_SEVERITY.CRITICAL]: v.literal(SIGNAL_SEVERITY.CRITICAL),
} as const satisfies Record<SignalSeverity, v.GenericSchema>;
const signalSeveritySchema = v.union([
  SIGNAL_SEVERITY_SCHEMAS.info,
  SIGNAL_SEVERITY_SCHEMAS.notice,
  SIGNAL_SEVERITY_SCHEMAS.warning,
  SIGNAL_SEVERITY_SCHEMAS.critical,
]);
const suggestionKindSchema = v.picklist(SUGGESTION_KINDS);

export const listSignalsQuerySchema = v.object({
  view: v.exactOptional(signalViewSchema),
  matterId: v.exactOptional(resourceIdSchema("workspace")),
  origin: v.exactOptional(signalOriginSchema),
  severity: v.exactOptional(signalSeveritySchema),
  assignedToMe: v.exactOptional(booleanFromString()),
  limit: v.exactOptional(
    numberFromString(paginationLimitSchema(LIMITS.signalsPageSizeMax)),
  ),
  cursor: v.exactOptional(paginationCursorSchema()),
});

export const signalParamsSchema = v.object({
  signalId: resourceIdSchema("signal"),
});

export const createRequestBodySchema = v.object({
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  description: v.pipe(v.string(), v.maxLength(10_000)),
  matterId: v.optional(v.nullable(resourceIdSchema("workspace"))),
  assigneeUserId: v.optional(v.nullable(resourceIdSchema("user"))),
  severity: v.optional(signalSeveritySchema),
});

export const snoozeBodySchema = v.object({
  until: apiDateTimeSchema,
});

export const dismissBodySchema = v.object({
  reason: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(1000)))),
});

export const assignBodySchema = v.object({
  assigneeUserId: v.nullable(resourceIdSchema("user")),
});

/**
 * Accepting names the suggestion taken. Server-executed kinds create the
 * result here; promotion reports the matter created by the client so
 * provenance survives the dialog boundary.
 */
export const acceptBodySchema = v.object({
  suggestionKind: suggestionKindSchema,
  result: v.optional(
    v.object({
      type: v.literal("workspace"),
      workspaceId: resourceIdSchema("workspace"),
    }),
  ),
});
