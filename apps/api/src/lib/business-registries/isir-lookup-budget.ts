/**
 * The insolvency register's requests for register lookups.
 *
 * The register's operating terms let the Ministry block a user sending more
 * than 3,000 requests a day or 50 a minute, whichever of its services on
 * isir.justice.cz they reach. The corpus walk spends its share through the
 * `isir-justice-cz` gate: one request every 40 s, 2,160 a day and under two a
 * minute. A lookup (`cz-insolvency`, behind `cz.isir.proceedings` and the
 * counterparty checks) spends from what is left, with margin: one request
 * every 2 s at most, and 600 a day. A lookup the day's budget cannot pay for
 * is refused before it asks, never sent.
 */
import { Result, TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";
import { DAY_IN_MS, todayFor } from "@stll/time";

import {
  createPublisherRequestSlot,
  deployedPublisherGateClient,
  type PublisherGateClient,
  publisherGateReserves,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import { coordinationKey } from "@/api/lib/redis-keys";
import { isLocalDevOpen } from "@/api/runtime-mode";

/** The least gap between two lookup requests: 30 a minute at most. */
const ISIR_LOOKUP_INTERVAL_MS = 2000;

/** The lookup requests a day may spend beside the corpus walk. */
export const ISIR_LOOKUP_DAILY_REQUESTS = 600;

/** A lookup asks twice: every proceeding, then the pending ones. */
export const ISIR_LOOKUP_REQUESTS = 2;

/** The register counts its days in Prague. */
const REGISTER_ZONE = "Europe/Prague";

const DAILY_QUOTA_SCRIPT = `
local used = redis.call("INCRBY", KEYS[1], ARGV[1])
if used == tonumber(ARGV[1]) then redis.call("PEXPIRE", KEYS[1], ARGV[3]) end
if used > tonumber(ARGV[2]) then
  redis.call("DECRBY", KEYS[1], ARGV[1])
  return 0
end
return 1
`;

export const ISIR_LOOKUP_REFUSAL = {
  /** The day's lookup budget is spent. */
  SPENT: "spent",
  /** The shared counter could not be read, so nothing is sent. */
  UNAVAILABLE: "unavailable",
} as const;

export class IsirLookupBudgetError extends TaggedError(
  "IsirLookupBudgetError",
)<{
  message: string;
  reason: (typeof ISIR_LOOKUP_REFUSAL)[keyof typeof ISIR_LOOKUP_REFUSAL];
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

export type IsirLookupBudgetDependencies = {
  /** Whether pacing applies at all (not in a local test run). */
  reserves: () => boolean;
  /** Takes `requests` from the day's count; false once it would pass `limit`. */
  takeFromDay: (
    day: string,
    requests: number,
    limit: number,
  ) => Promise<boolean>;
  /** Waits for one request's slot. */
  reserveSlot: (signal?: AbortSignal) => Promise<void>;
  /** The register's day the count is kept for. */
  today: () => string;
};

const lookupSlot = createPublisherRequestSlot({
  intervalMs: ISIR_LOOKUP_INTERVAL_MS,
  key: "isir-justice-cz-lookups",
  publisherCode: "isir-justice-cz",
  publisher: "Ministerstvo spravedlnosti",
});

const localDays = new Map<string, number>();

const sharedClient = async (): Promise<PublisherGateClient | null> =>
  isLocalDevOpen() ? null : await deployedPublisherGateClient();

const defaultDependencies: IsirLookupBudgetDependencies = {
  reserves: publisherGateReserves,
  takeFromDay: async (day, requests, limit) => {
    const client = await sharedClient();
    if (client === null) {
      // One process alone in local development keeps its own count.
      const used = (localDays.get(day) ?? 0) + requests;
      if (used > limit) {
        return false;
      }
      localDays.set(day, used);
      return true;
    }
    const reply = await client.send("EVAL", [
      DAILY_QUOTA_SCRIPT,
      "1",
      coordinationKey({
        scope: "case-law-publisher-gate",
        slot: "isir-justice-cz-lookups",
        suffix: `day:${day}`,
      }),
      String(requests),
      String(limit),
      String(2 * DAY_IN_MS),
    ]);
    return reply === 1;
  },
  reserveSlot: lookupSlot,
  today: () => todayFor(REGISTER_ZONE).toString(),
};

/**
 * Pays for one lookup before it is sent: its requests from the day's budget,
 * then a slot for each, so lookups never come closer than the interval.
 */
export const reserveIsirLookup = async (
  signal: AbortSignal | undefined,
  dependencies: IsirLookupBudgetDependencies = defaultDependencies,
): Promise<Result<void, IsirLookupBudgetError>> => {
  if (!dependencies.reserves()) {
    return Result.ok(undefined);
  }
  const taken = await Result.tryPromise(
    async () =>
      await dependencies.takeFromDay(
        dependencies.today(),
        ISIR_LOOKUP_REQUESTS,
        ISIR_LOOKUP_DAILY_REQUESTS,
      ),
  );
  if (Result.isError(taken)) {
    return Result.err(
      new IsirLookupBudgetError({
        message: "The insolvency register's lookup budget could not be read",
        reason: ISIR_LOOKUP_REFUSAL.UNAVAILABLE,
        cause: taken.error,
      }),
    );
  }
  if (!taken.value) {
    return Result.err(
      new IsirLookupBudgetError({
        message: "The insolvency register's lookups for today are spent",
        reason: ISIR_LOOKUP_REFUSAL.SPENT,
      }),
    );
  }
  for (let request = 0; request < ISIR_LOOKUP_REQUESTS; request += 1) {
    // Each request waits for its own slot, in order.
    const slot = await Result.tryPromise(
      async () => await dependencies.reserveSlot(signal),
    );
    if (Result.isError(slot)) {
      return Result.err(
        new IsirLookupBudgetError({
          message: "The insolvency register's lookup pacing is unavailable",
          reason: ISIR_LOOKUP_REFUSAL.UNAVAILABLE,
          cause: slot.error,
        }),
      );
    }
  }
  return Result.ok(undefined);
};
