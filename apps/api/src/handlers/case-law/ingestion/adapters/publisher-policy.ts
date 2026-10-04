// parser-output-unchanged: completion admission uses typed Results and job-boundary rejection; parsing and stored output are unchanged.
// parser-output-unchanged: gate definitions share their owner and immediate request-boundary checks share publisher pacing; response parsing and stored output are unchanged.
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

import { panic, Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { DAY_IN_MS } from "@stll/time";

import {
  createPublisherRequestSlot,
  PublisherPacingStopped,
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

const MILLISECONDS_PER_SECOND = 1000;
const MAX_PUBLISHER_REQUESTS_PER_SECOND = 2;

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
) =>
  createPublisherGateSlotAtInterval({
    gateId,
    intervalMs: PUBLISHER_GATES[gateId].intervalMs,
    ...(dependencies === undefined ? {} : { dependencies }),
  });

type CreatePublisherGateSlotWithIntervalOptions = {
  gateId: PublisherGateId;
  intervalMs: number;
  dependencies?: PublisherRequestGateDependencies;
};

const createPublisherGateSlotAtInterval = ({
  gateId,
  intervalMs,
  dependencies,
}: CreatePublisherGateSlotWithIntervalOptions) => {
  const { publisher } = PUBLISHER_GATES[gateId];
  return createPublisherRequestSlot(
    {
      intervalMs: Math.max(PUBLISHER_GATES[gateId].intervalMs, intervalMs),
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

type RunPublisherLimit = {
  gateId: "cellar-eu";
  gateSlot: ReturnType<typeof createPublisherGateSlot>;
  controls?: PublisherRunControls;
};

type PublisherRunControls = {
  check: () => Promise<Result<void, unknown>>;
  checkBeforeSend: () => Result<void, unknown>;
  chargeRequest: () => Promise<Result<void, unknown>>;
  /** The job boundary adapts typed failures to the adapter's Promise rejection contract. */
  raiseFailure: (error: unknown) => never;
  retry: "durable";
  onRefusal?: (cooldownUntilEpochMs: number) => void;
  onFailure?: (error: unknown) => void;
  limitResponse?: (response: Response) => Response;
};

const runPublisherLimit = new AsyncLocalStorage<RunPublisherLimit>();

export const publisherRunControls = (gateId: PublisherGateId) => {
  const run = runPublisherLimit.getStore();
  return run?.gateId === gateId ? run.controls : undefined;
};

// Immediate mode checks the shared gate at every outbound request boundary.
const immediateRequestGate = new AsyncLocalStorage<{
  gateId: PublisherGateId;
  slot: ReturnType<typeof createPublisherGateSlot>;
}>();

type WithImmediatePublisherSlotOptions<T> = {
  adapterKey: AdapterKey;
  operation: () => Promise<T>;
  dependencies?: PublisherRequestGateDependencies;
};

export type PublisherPacingOutcome = PublisherPacingStopped["status"];

export type ImmediatePublisherSlotResult<T> =
  | { status: "completed"; value: T }
  | { status: PublisherPacingOutcome }
  | { status: "failed"; error: unknown };

export const withImmediatePublisherSlot = async <T>({
  adapterKey,
  operation,
  dependencies,
}: WithImmediatePublisherSlotOptions<T>): Promise<
  ImmediatePublisherSlotResult<T>
> => {
  const gateId = ADAPTER_PUBLISHER_GATES[adapterKey];
  const slot =
    dependencies === undefined
      ? getPublisherGateSlot(gateId)
      : createPublisherGateSlot(gateId, dependencies);
  const result = await Result.tryPromise({
    try: async () =>
      await immediateRequestGate.run({ gateId, slot }, operation),
    catch: (error) => error,
  });
  if (Result.isOk(result)) {
    return { status: "completed", value: result.value };
  }
  if (PublisherPacingStopped.is(result.error)) {
    return { status: result.error.status };
  }
  return { status: "failed", error: result.error };
};

const getPublisherGateSlot = (gateId: PublisherGateId) => {
  const slot = slotsByGate.get(gateId) ?? createPublisherGateSlot(gateId);
  slotsByGate.set(gateId, slot);
  return slot;
};

type WithPublisherRequestRateLimitOptions<T> = {
  gateId: "cellar-eu";
  requestsPerSecond: number;
  operation: () => Promise<T>;
  dependencies?: PublisherRequestGateDependencies;
  controls?: PublisherRunControls;
};

/**
 * Apply a run-specific interval through the shared EU publisher gate, so
 * retries, cooldowns, and coordination use the same reservation.
 */
export const withPublisherRequestRateLimit = async <T>({
  gateId,
  requestsPerSecond,
  operation,
  dependencies,
  controls,
}: WithPublisherRequestRateLimitOptions<T>): Promise<T> => {
  if (
    !Number.isFinite(requestsPerSecond) ||
    requestsPerSecond <= 0 ||
    requestsPerSecond > MAX_PUBLISHER_REQUESTS_PER_SECOND
  ) {
    return panic(
      `requestsPerSecond must be greater than 0 and at most ${MAX_PUBLISHER_REQUESTS_PER_SECOND}`,
    );
  }

  const requestedIntervalMs = Math.ceil(
    MILLISECONDS_PER_SECOND / requestsPerSecond,
  );
  return await runPublisherLimit.run(
    {
      gateId,
      ...(controls === undefined ? {} : { controls }),
      gateSlot: createPublisherGateSlotAtInterval({
        gateId,
        intervalMs: requestedIntervalMs,
        ...(dependencies === undefined ? {} : { dependencies }),
      }),
    },
    operation,
  );
};

export const reservePublisherSlot = async (
  adapterKey: AdapterKey,
  signal?: AbortSignal,
): Promise<void> =>
  await reservePublisherGateSlot(ADAPTER_PUBLISHER_GATES[adapterKey], signal);

export const reservePublisherGateSlot = async (
  gateId: PublisherGateId,
  signal?: AbortSignal,
): Promise<void> => {
  const immediate = immediateRequestGate.getStore();
  if (immediate?.gateId === gateId) {
    await immediate.slot.reserveImmediately(signal);
    return;
  }
  const runLimit = runPublisherLimit.getStore();
  if (runLimit?.gateId === gateId) {
    await runLimit.gateSlot(signal);
    return;
  }
  if (!publisherGateReserves()) {
    return;
  }
  await getPublisherGateSlot(gateId)(signal);
};

export const deferPublisherGate = async (
  gateId: PublisherGateId,
  durationMs: number,
  signal?: AbortSignal,
): Promise<number> => {
  const runLimit = runPublisherLimit.getStore();
  const reserve =
    (runLimit?.gateId === gateId ? runLimit.gateSlot : undefined) ??
    getPublisherGateSlot(gateId);
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
  const runLimit = runPublisherLimit.getStore();
  const reserve =
    (runLimit?.gateId === publisherKey ? runLimit.gateSlot : undefined) ??
    getPublisherGateSlot(publisherKey);
  return await reserve.readCooldown();
};
