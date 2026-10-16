import type { Result } from "better-result";

import type {
  OutboundActionKind,
  OutboundActionPreview,
} from "@stll/api-contract/outbound-action";

import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";

/** A provider refusal, reported to the user by its stable code. */
export type OutboundActionFailure = { failureCode: string };

/**
 * Performs one confirmed outbound action as the user. It receives the stored,
 * hash-checked preview and nothing the assistant can still change. It runs at
 * most once per action: an interrupted run is never retried.
 */
export type OutboundActionExecutor = (context: {
  actionId: SafeId<"outboundAction">;
  organizationId: SafeId<"organization">;
  preview: OutboundActionPreview;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}) => Promise<Result<{ providerMessageId: string }, OutboundActionFailure>>;

export type OutboundActionExecutors = Record<
  OutboundActionKind,
  OutboundActionExecutor | undefined
>;

/** Kinds with a provider wired in; a kind without one cannot be confirmed. */
export const OUTBOUND_ACTION_EXECUTORS = {
  "email.send": undefined,
} as const satisfies OutboundActionExecutors;
