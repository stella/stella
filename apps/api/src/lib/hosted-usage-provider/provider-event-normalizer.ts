/**
 * Maps an authenticated, raw webhook body into the provider-neutral
 * event shape that `event-schemas.ts` validates and `dispatch.ts`
 * consumes.
 *
 * The signature/dedup/dispatch pipeline is provider-agnostic; this is the
 * single seam where a concrete provider's native event names and payload
 * field names are translated. Normalisation runs after signature
 * verification and before strict schema validation in `receive.ts`.
 */

import { isHostedUsageHandledEventType } from "@/api/handlers/hosted-usage-webhook/event-schemas";
import type { HostedUsageProviderKind } from "@/api/lib/hosted-usage-provider/config";
import { normalizePolarEvent } from "@/api/lib/hosted-usage-provider/polar/events";

export type NormalizedProviderEvent = {
  /** The object to validate against `hostedUsageWebhookEventSchema`. */
  candidate: unknown;
  /**
   * Whether a strict-parse failure of `candidate` should be treated as a
   * malformed *handled* event (-> 400 so the provider retries) rather than
   * an unhandled event type (-> recorded `ignored` + 200). This keeps the
   * neutral pipeline's fail-loud guarantee for events we are meant to act
   * on, even though the recorded native event type (e.g. `subscription.active`)
   * is not itself one of the neutral handled types.
   */
  handled: boolean;
};

export const normalizeProviderEvent = (
  raw: unknown,
  nativeType: string,
  kind: HostedUsageProviderKind,
): NormalizedProviderEvent => {
  if (kind === "polar") {
    return normalizePolarEvent(raw, nativeType);
  }
  // Neutral provider: the body is already in the neutral contract, so the
  // candidate is the raw body and "handled" mirrors the neutral type set.
  return { candidate: raw, handled: isHostedUsageHandledEventType(nativeType) };
};
