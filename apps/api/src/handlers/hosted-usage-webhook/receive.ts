/**
 * Hosted usage webhook receive handler.
 *
 * Security model:
 *  - HMAC signature is the ONLY authentication. Requests without
 *    a configured webhook secret are rejected with 503; requests
 *    that fail signature verification are rejected with 401 and
 *    NO payload contents are written to logs.
 *  - The `usage_provider_webhook_events` table provides structural
 *    idempotency: duplicate delivery of the same event id becomes
 *    an `ON CONFLICT DO NOTHING` insert and an immediate 200.
 *  - Ownership IDs come from the local database join on
 *    local hosted account / entitlement identifiers, NEVER from the
 *    provider payload alone (see dispatch.ts).
 *
 * Consistency model: the dedupe insert and the dispatch mutations
 * happen in the *same* transaction. If dispatch throws, the dedupe
 * row rolls back with it, so the provider retry sees a clean slate and
 * tries the work again — no event can be silently dropped because
 * "we already inserted the row but never did the work."
 *
 * Connection model: the webhook is unauthenticated so there is no
 * `ctx.scopedDb`. Per /conventions-security ("Handlers must not
 * import the root db module"), all `rootDb` access lives in
 * `lib/hosted-usage-provider/webhook-store.ts` and is imported here as
 * narrow helpers.
 */

import { panic } from "better-result";
import * as v from "valibot";

import {
  handleHostedAllocation,
  handleUsageEntitlementStatusChange,
  handleHostedEntitlementUpsert,
} from "@/api/handlers/hosted-usage-webhook/dispatch";
import type { DispatchOutcome } from "@/api/handlers/hosted-usage-webhook/dispatch";
import { captureError } from "@/api/lib/analytics/capture";
import {
  getHostedUsageProviderKind,
  getWebhookSecret,
} from "@/api/lib/hosted-usage-provider/config";
import {
  hostedUsageUnknownEventEnvelopeSchema,
  hostedUsageWebhookEventSchema,
} from "@/api/lib/hosted-usage-provider/event-schemas";
import { normalizeProviderEvent } from "@/api/lib/hosted-usage-provider/provider-event-normalizer";
import { verifyWebhookSignature } from "@/api/lib/hosted-usage-provider/verify-signature";
import {
  insertWebhookEventInTx,
  runWebhookTransaction,
  updateWebhookEventResultInTx,
} from "@/api/lib/hosted-usage-provider/webhook-store";
import type { WebhookTransactionRunner } from "@/api/lib/hosted-usage-provider/webhook-store";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";

export const HOSTED_USAGE_WEBHOOK_HEADERS = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const;

type ReceiveCtx = {
  request: Request;
  body: string;
  /** The transaction the event record and its dispatch run in; the root connection by default. */
  runTransaction?: WebhookTransactionRunner;
};

const respond = (statusCode: number, message: string): Response =>
  new Response(JSON.stringify({ message }), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });

export const receiveHostedUsageWebhook = async (
  ctx: ReceiveCtx,
): Promise<Response> => {
  const runTransaction = ctx.runTransaction ?? runWebhookTransaction;
  const webhookConfig = getWebhookSecret();
  if (!webhookConfig) {
    // Hosted usage management is not configured on this deployment. We must
    // not 404 — that would tell a probing attacker the route
    // exists; 503 reads as "deliberately unavailable here."
    return respond(503, "Hosted usage management not configured");
  }

  const rawBody = ctx.body;
  const headers = {
    id: ctx.request.headers.get(HOSTED_USAGE_WEBHOOK_HEADERS.id),
    timestamp: ctx.request.headers.get(HOSTED_USAGE_WEBHOOK_HEADERS.timestamp),
    signature: ctx.request.headers.get(HOSTED_USAGE_WEBHOOK_HEADERS.signature),
  };

  const verification = verifyWebhookSignature({
    secrets: webhookConfig.secrets,
    rawBody,
    headers,
  });
  if (!verification.ok) {
    return respond(401, "Invalid signature");
  }

  // Past signature check: the request is authentic. Now we own
  // the contents — parse, dedupe, dispatch.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch (error) {
    captureError(error, { source: "usage_provider.webhook.json_parse" });
    return respond(400, "Malformed JSON body");
  }

  const envelopeResult = v.safeParse(
    hostedUsageUnknownEventEnvelopeSchema,
    parsedJson,
  );
  if (!envelopeResult.success) {
    return respond(400, "Malformed envelope");
  }
  const envelope = envelopeResult.output;

  const eventId = headers.id;
  if (!eventId) {
    // verifyWebhookSignature already caught this, but TypeScript
    // doesn't see the narrowing. Defensive check + 400.
    return respond(400, "Missing webhook-id");
  }

  if (!isRecord(parsedJson)) {
    return respond(400, "Malformed payload");
  }
  const payload = parsedJson;

  // Translate the (already authenticated) body into the neutral event
  // contract before validating it. For the neutral provider this is a
  // pass-through; the Polar adapter renames `subscription.*` / `order.*`
  // events into `entitlement.*` / `allocation.*`. We record the native
  // event type and original payload for audit, and dispatch on the
  // normalised event.
  //
  // Validation happens BEFORE opening a transaction. Unknown event types
  // are recorded in their own tiny transaction (insert with
  // result="ignored") and acknowledged once recorded, so the provider stops
  // retrying. A record Postgres rejects as invalid data is reported and
  // acknowledged; any other write failure answers 500 for a retry.
  const normalized = normalizeProviderEvent(
    parsedJson,
    envelope.type,
    getHostedUsageProviderKind(),
  );
  const strict = v.safeParse(
    hostedUsageWebhookEventSchema,
    normalized.candidate,
  );
  if (!strict.success) {
    if (normalized.handled) {
      return respond(400, "Malformed payload for handled event type");
    }
    const recorded = await persistUnknownEventType({
      runTransaction,
      eventId,
      eventType: envelope.type,
      payload,
    });
    if (recorded === UNKNOWN_EVENT_RECORD.retry) {
      // Nothing committed: the record's insert and result update share one
      // transaction, and the insert is keyed on the event id, so the
      // provider's retry of this 500 records it once.
      return respond(500, "Event record failed");
    }
    return respond(200, "Event type ignored");
  }
  const event = strict.output;

  // Single atomic transaction: dedupe + dispatch + result-update.
  // Throws here roll back the dedupe row too; the provider retry will
  // hit a clean table and try again.
  let outcome:
    | { kind: "duplicate" }
    | { kind: "applied" | "ignored"; inner: DispatchOutcome };
  try {
    outcome = await runTransaction(async (tx) => {
      const inserted = await insertWebhookEventInTx({
        tx,
        eventId,
        eventType: envelope.type,
        payload,
        initialResult: "ok",
      });
      if (inserted.kind === "duplicate") {
        return { kind: "duplicate" } as const;
      }

      const dispatched = await dispatchEvent(tx, event, eventId);

      if (dispatched.kind === "ignored") {
        await updateWebhookEventResultInTx({
          tx,
          eventId,
          result: "ignored",
          errorMessage: dispatched.reason,
        });
        return { kind: "ignored" as const, inner: dispatched };
      }
      // "applied" or "duplicate_allocation" — leave result="ok" (set
      // at insert time).
      return { kind: "applied" as const, inner: dispatched };
    });
  } catch (error) {
    // The dispatch transaction rolled back, so the dedupe row is
    // NOT committed either. The provider will retry on our 500 and the
    // next attempt finds a clean table and tries again — that's
    // the whole point of doing dedupe + dispatch in one tx.
    // Failure visibility comes from captureError and the provider's
    // webhook delivery dashboard; we deliberately do
    // NOT persist a failure row, because that would re-introduce
    // the "dedupe committed without dispatch" hole this refactor
    // closed.
    captureError(error, {
      source: "usage_provider.webhook.dispatch",
      eventId,
      eventType: envelope.type,
    });
    return respond(500, "Dispatch failed");
  }

  if (outcome.kind === "duplicate") {
    return respond(200, "Already processed");
  }
  if (outcome.kind === "ignored") {
    return respond(200, "Event ignored");
  }
  return respond(200, "Applied");
};

const UNKNOWN_EVENT_RECORD = {
  written: "written",
  /** Postgres refused the data itself, which a redelivery carries unchanged. */
  rejected: "rejected",
  /** Anything else: the provider redelivers and the write runs again. */
  retry: "retry",
} as const;

type UnknownEventRecord =
  (typeof UNKNOWN_EVENT_RECORD)[keyof typeof UNKNOWN_EVENT_RECORD];

const unknownEventRecordRejected = failureSink({
  event: "usage_provider.webhook.unknown_event_persist",
  expected: [],
});

const persistUnknownEventType = async ({
  runTransaction,
  eventId,
  eventType,
  payload,
}: {
  runTransaction: WebhookTransactionRunner;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<UnknownEventRecord> => {
  try {
    await runTransaction(async (tx) => {
      const inserted = await insertWebhookEventInTx({
        tx,
        eventId,
        eventType,
        payload,
        initialResult: "ignored",
      });
      if (inserted.kind === "fresh") {
        await updateWebhookEventResultInTx({
          tx,
          eventId,
          result: "ignored",
          errorMessage: "unhandled event type",
        });
      }
    });
    return UNKNOWN_EVENT_RECORD.written;
  } catch (error) {
    if (isPgDataException(error)) {
      // A redelivery carries the same data, so the rejection is reported
      // (graded unclassified: logged as an error and captured) and the
      // event acknowledged.
      observeFailure(error, {
        sink: unknownEventRecordRejected,
        ctx: {
          source: "usage_provider.webhook",
          step: "persistUnknownEventType",
        },
      });
      return UNKNOWN_EVENT_RECORD.rejected;
    }
    captureError(error, {
      source: "usage_provider.webhook.unknown_event_persist",
      eventId,
      eventType,
    });
    return UNKNOWN_EVENT_RECORD.retry;
  }
};

/** SQLSTATE class 22: Postgres rejected a value, not the connection or the transaction. */
const isPgDataException = (error: unknown): boolean =>
  getPgErrorCode(error)?.startsWith("22") === true;

const dispatchEvent = async (
  tx: Parameters<typeof handleHostedEntitlementUpsert>[0]["tx"],
  event: v.InferOutput<typeof hostedUsageWebhookEventSchema>,
  eventId: string,
): Promise<DispatchOutcome> => {
  switch (event.type) {
    case "entitlement.created":
    case "entitlement.updated":
    case "entitlement.active":
      return await handleHostedEntitlementUpsert({
        tx,
        payload: event.data,
        eventId,
      });
    case "entitlement.canceled":
      return await handleUsageEntitlementStatusChange({
        tx,
        payload: event.data,
        eventId,
        eventKind: "canceled",
      });
    case "entitlement.revoked":
      return await handleUsageEntitlementStatusChange({
        tx,
        payload: event.data,
        eventId,
        eventKind: "revoked",
      });
    case "allocation.created":
      return await handleHostedAllocation({ tx, payload: event.data, eventId });
    default: {
      event satisfies never;
      return panic(`Unhandled event: ${String(event)}`);
    }
  }
};
