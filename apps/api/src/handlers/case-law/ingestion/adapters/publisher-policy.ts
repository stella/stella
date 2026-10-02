// parser-output-unchanged: publisher scheduling only; response parsing is unchanged.
/**
 * What each publisher costs, declared once, and the only fetch that spends it.
 *
 * A budget an adapter keeps for itself is a budget the next adapter does not
 * know about, and a loop that reaches the publisher through a plain `fetch`
 * spends requests nothing counts. So the pacing is not a habit of any loop:
 * every adapter names its publisher here, the shared publisher-gates map names
 * its interval, and `retry.ts` reserves a slot before the request leaves.
 * `publisher-gate-coverage.test.ts` fails the build on an adapter module that
 * reaches the network any other way.
 *
 * The interval is the declared figure and the daily ceiling is derived from
 * it ({@link publisherRequestsPerDay}), not the other way round: it is what
 * the gate enforces, and three of these publishers stated a gap between
 * requests rather than a total.
 */

import { DAY_IN_MS } from "@stll/time";

import {
  createPublisherRequestSlot,
  publisherGateReserves,
  type PublisherRequestGateDependencies,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  PUBLISHER_GATES,
  type PublisherGateId,
} from "@/api/lib/legal-search/publisher-gates";

export {
  NALUS_DAILY_REQUEST_LIMIT,
  PUBLISHER_GATES,
} from "@/api/lib/legal-search/publisher-gates";
export type { PublisherGateId } from "@/api/lib/legal-search/publisher-gates";

/**
 * Which publisher each adapter spends against.
 *
 * Total by type: an adapter key added to {@link ADAPTER_KEYS} without a
 * publisher does not compile, which is the point — an adapter cannot reach
 * the network without first having named whose budget it is spending.
 */
export const ADAPTER_PUBLISHER_GATES = {
  [ADAPTER_KEYS.CZ_US]: "nalus-usoud",
  [ADAPTER_KEYS.CZ_NS]: "nsoud-cz",
  [ADAPTER_KEYS.CZ_NSS]: "nssoud-cz",
  [ADAPTER_KEYS.CZ_REGIONAL]: "justice-cz",
  [ADAPTER_KEYS.SK_COURTS]: "justice-sk",
  [ADAPTER_KEYS.SK_US]: "ustavnysud-sk",
  [ADAPTER_KEYS.PL_COURTS]: "saos-pl",
  [ADAPTER_KEYS.PL_SN]: "sn-pl",
  [ADAPTER_KEYS.PL_KIO]: "uzp-pl",
  [ADAPTER_KEYS.PL_TK]: "trybunal-pl",
  [ADAPTER_KEYS.PL_NSA]: "huggingface-datasets",
  [ADAPTER_KEYS.PL_NCOURT]: "ms-gov-pl",
  [ADAPTER_KEYS.AT_COURTS]: "ris-bka",
  [ADAPTER_KEYS.AT_VFGH]: "ris-bka",
  [ADAPTER_KEYS.AT_VWGH]: "ris-bka",
  [ADAPTER_KEYS.AT_BVWG]: "ris-bka",
  [ADAPTER_KEYS.AT_LVWG]: "ris-bka",
  [ADAPTER_KEYS.AT_ASYLGH]: "ris-bka",
  [ADAPTER_KEYS.AT_UBAS]: "ris-bka",
  [ADAPTER_KEYS.AT_UVS]: "ris-bka",
  [ADAPTER_KEYS.AT_VERG]: "ris-bka",
  [ADAPTER_KEYS.AT_UMSE]: "ris-bka",
  [ADAPTER_KEYS.AT_BKS]: "ris-bka",
  [ADAPTER_KEYS.AT_FINDOK]: "findok-bmf",
  [ADAPTER_KEYS.EU_ECJ]: "cellar-eu",
  [ADAPTER_KEYS.HU_BHGY]: "birosag-hu",
  [ADAPTER_KEYS.PL_KIS]: "eureka-mf",
  [ADAPTER_KEYS.PL_UODO]: "uodo-gov-pl",
  [ADAPTER_KEYS.PL_UOKIK]: "uokik-gov-pl",
} as const satisfies Record<AdapterKey, PublisherGateId>;

/** The hosts an adapter's publisher serves from. */
export const publisherHosts = (adapterKey: AdapterKey): readonly string[] =>
  PUBLISHER_GATES[ADAPTER_PUBLISHER_GATES[adapterKey]].hosts;

/** Minimum gap between two requests the adapter sends to its publisher. */
export const publisherRequestIntervalMs = (adapterKey: AdapterKey): number =>
  PUBLISHER_GATES[ADAPTER_PUBLISHER_GATES[adapterKey]].intervalMs;

/** What the declared interval leaves the whole slice per publisher per day. */
export const publisherRequestsPerDay = (gateId: PublisherGateId): number =>
  Math.floor(DAY_IN_MS / PUBLISHER_GATES[gateId].intervalMs);

/**
 * The gate for one adapter's publisher, with the reservation seam exposed.
 *
 * Tests reach the gate through this to drive the reservation without Redis
 * or a clock; production goes through {@link fetchPublisher}.
 */
export const createPublisherSlot = (
  adapterKey: AdapterKey,
  dependencies?: PublisherRequestGateDependencies,
) => createPublisherGateSlot(ADAPTER_PUBLISHER_GATES[adapterKey], dependencies);

/**
 * The gate for a publisher this slice reaches outside a crawl — a roster
 * import, say. Named by gate rather than by adapter, because the host it
 * spends against is not the one any adapter's cursor walks.
 */
export const createPublisherGateSlot = (
  gateId: PublisherGateId,
  dependencies?: PublisherRequestGateDependencies,
) => {
  const { publisher, intervalMs } = PUBLISHER_GATES[gateId];
  return createPublisherRequestSlot(
    {
      intervalMs,
      key: gateId,
      publisher,
      ...(gateId === "cellar-eu" ? { cooldown: "shared" as const } : {}),
    },
    dependencies,
  );
};

/**
 * One reserver per gate, created on first use.
 *
 * Lazy rather than a map built at import: the gate resolves its Redis client
 * when it first reserves, and a module that builds every gate eagerly would
 * pull that resolution into import order.
 */
const slotsByGate = new Map<
  PublisherGateId,
  ReturnType<typeof createPublisherGateSlot>
>();

export const reservePublisherSlot = async (
  adapterKey: AdapterKey,
  signal?: AbortSignal,
): Promise<void> => {
  await reservePublisherGateSlot(ADAPTER_PUBLISHER_GATES[adapterKey], signal);
};

export const reservePublisherGateSlot = async (
  gateId: PublisherGateId,
  signal?: AbortSignal,
): Promise<void> => {
  if (!publisherGateReserves()) {
    return;
  }
  const reserve = slotsByGate.get(gateId) ?? createPublisherGateSlot(gateId);
  slotsByGate.set(gateId, reserve);
  await reserve(signal);
};

export const deferPublisherGate = async (
  gateId: PublisherGateId,
  durationMs: number,
  signal?: AbortSignal,
): Promise<number> => {
  const reserve = slotsByGate.get(gateId) ?? createPublisherGateSlot(gateId);
  slotsByGate.set(gateId, reserve);
  return await reserve.defer(durationMs, signal);
};

/** Shared deadline in epoch milliseconds, based on Redis TIME, not the caller clock. */
export const readPublisherCooldown = async (
  publisherKey: PublisherGateId,
  dependencies?: PublisherRequestGateDependencies,
): Promise<number | null> => {
  if (dependencies !== undefined) {
    return await createPublisherGateSlot(
      publisherKey,
      dependencies,
    ).readCooldown();
  }
  const reserve =
    slotsByGate.get(publisherKey) ?? createPublisherGateSlot(publisherKey);
  slotsByGate.set(publisherKey, reserve);
  return await reserve.readCooldown();
};
