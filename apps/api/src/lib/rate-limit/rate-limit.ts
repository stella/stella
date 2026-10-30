import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import type { ResponseSet } from "@/api/http/context";
import { isEarlyHttpFailure } from "@/api/http/errors";
import { toResponse } from "@/api/http/respond";
import type { Middleware } from "@/api/http/route";
import { status } from "@/api/http/status";
import {
  type RateLimitClientAddressOptions,
  resolveRateLimitClientAddress,
} from "@/api/lib/client-ip";
import { recordBudgetRejection } from "@/api/lib/rate-limit/budget-observability";
import type {
  RateLimitBudget,
  RateLimitContext,
  RateLimitContextConfig,
  RateLimitGenerator,
  RateLimitOptions,
  ReadableRateLimitContext,
} from "@/api/lib/rate-limit/contracts";

type RateLimitEntry = {
  count: number;
  start: number;
  expiresAt: number;
};

const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Key generator that prefixes the client IP with a scope
 * name, so separate rateLimit instances get independent
 * counters.
 */
export const scopedGenerator =
  (scope: string): RateLimitGenerator =>
  (request, server) =>
    scopedRateLimitKey({ scope, request, server });

type ScopedRateLimitKeyOptions = RateLimitClientAddressOptions & {
  scope: string;
};

export const scopedRateLimitKey = ({
  scope,
  ...clientAddress
}: ScopedRateLimitKeyOptions): string => {
  const address = resolveRateLimitClientAddress(clientAddress);
  return address === null ? scope : `${scope}:${address}`;
};

/**
 * In-memory rate limiting. Each process maintains its own
 * counters; with multiple instances, a client may get up
 * to N× the configured limit. The hard global limit is
 * enforced at the network edge.
 */
export class InMemoryRateLimitContext implements ReadableRateLimitContext {
  private durationMs = 60_000;
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(
      () => this.evictExpired(),
      CLEANUP_INTERVAL_MS,
    );
    this.cleanupTimer.unref();
  }

  init({ duration }: RateLimitContextConfig) {
    this.durationMs = duration;
  }

  read(key: string) {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= Temporal.Now.instant().epochMilliseconds) {
      return null;
    }
    return {
      count: entry.count,
      nextReset: new Date(entry.expiresAt),
      start: entry.start,
    };
  }

  increment(key: string, duration?: number, requestTime?: number) {
    const effectiveDuration = duration ?? this.durationMs;
    const now = requestTime ?? Temporal.Now.instant().epochMilliseconds;
    const entry = this.store.get(key);

    if (entry && entry.expiresAt > now) {
      entry.count += 1;
      return {
        count: entry.count,
        nextReset: new Date(entry.expiresAt),
        start: entry.start,
      };
    }

    const expiresAt = now + effectiveDuration;
    this.store.set(key, { count: 1, start: now, expiresAt });
    return {
      count: 1,
      nextReset: new Date(expiresAt),
      start: now,
    };
  }

  complete(_key: string): void {
    // In-memory counters retain no refund identities.
  }

  decrement(key: string, windowStart?: number) {
    const now = Temporal.Now.instant().epochMilliseconds;
    const entry = this.store.get(key);
    if (
      entry &&
      entry.expiresAt > now &&
      entry.count > 0 &&
      (windowStart === undefined || entry.start === windowStart)
    ) {
      entry.count -= 1;
    }
  }

  reset(key?: string) {
    if (key) {
      this.store.delete(key);
    } else {
      this.store.clear();
    }
  }

  kill() {
    clearInterval(this.cleanupTimer);
    this.store.clear();
  }

  private evictExpired() {
    const now = Temporal.Now.instant().epochMilliseconds;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}

/** One window a request was charged in; refunds touch only that window. */
type RateLimitCharge = { key: string; windowStart: number };

export const DEFAULT_RATE_LIMIT_ERROR_RESPONSE = "rate-limit reached";

/**
 * Middleware `rateLimit` built. The composed-route census asserts every `/v1`
 * route carries one, which a function's name cannot guarantee.
 */
const rateLimitMiddleware = new WeakSet<Middleware>();

/** Whether a route middleware came out of `rateLimit`. */
export const isRateLimitMiddleware = (middleware: Middleware): boolean =>
  rateLimitMiddleware.has(middleware);

/**
 * Middleware that only spends a budget (a request count or a concurrency
 * slot) and refuses nothing else. Capability executors draw on budgets of
 * their own, so skipping a route budget on that path skips no access check.
 */
const routeBudgets = new WeakSet<Middleware>();

export const asRouteBudget = (middleware: Middleware): Middleware => {
  routeBudgets.add(middleware);
  return middleware;
};

/** Whether a route middleware only spends a budget. */
export const isRouteBudget = (middleware: Middleware): boolean =>
  routeBudgets.has(middleware);

/** Every counter store a limiter owns, closed once when the server stops. */
const ownedContexts = new Set<RateLimitContext>();

export const closeRateLimitContexts = async (): Promise<void> => {
  const contexts = [...ownedContexts];
  ownedContexts.clear();
  await Promise.all(contexts.map(async (context) => await context.kill()));
};

const writeRateLimitHeaders = ({
  max,
  remaining,
  reset,
  retryAfter,
  set,
}: {
  max: number;
  remaining: number;
  reset: number;
  retryAfter: boolean;
  set: ResponseSet;
}): void => {
  const previousRemaining = Number(set.headers["RateLimit-Remaining"]);
  const previousReset = Number(set.headers["RateLimit-Reset"]);
  // Keep one complete policy tuple: the tightest remaining budget wins,
  // with the earliest reset breaking ties between equally tight budgets.
  if (
    set.headers["RateLimit-Remaining"] === undefined ||
    remaining < previousRemaining ||
    (remaining === previousRemaining && reset < previousReset)
  ) {
    set.headers["RateLimit-Limit"] = String(max);
    set.headers["RateLimit-Remaining"] = String(remaining);
    set.headers["RateLimit-Reset"] = String(reset);
  }
  if (retryAfter) {
    set.headers["Retry-After"] = String(reset);
  }
};

/** Charge one window, write its headers, and report whether it is exhausted. */
const chargeWindow = async ({
  context,
  budget,
  set,
}: {
  context: RateLimitContext;
  budget: RateLimitBudget;
  set: ResponseSet;
}): Promise<{ charge: RateLimitCharge; exceeded: boolean }> => {
  const { count, nextReset, start } = await context.increment(
    budget.key,
    budget.duration,
    Temporal.Now.instant().epochMilliseconds,
  );
  const exceeded = count > budget.max;
  writeRateLimitHeaders({
    max: budget.max,
    remaining: Math.max(budget.max - count, 0),
    reset: Math.max(
      0,
      Math.ceil(
        (nextReset.getTime() - Temporal.Now.instant().epochMilliseconds) / 1000,
      ),
    ),
    retryAfter: exceeded,
    set,
  });
  return { charge: { key: budget.key, windowStart: start }, exceeded };
};

/**
 * Stella's replica-safe fixed-window limiter for a route group.
 *
 * Every request is charged before its route runs, so a request refused for
 * its input still spends its budget. A charge is refunded only when the
 * handler itself fails; charges settle with the counter store once the answer
 * is built. Counter storage, outage behavior, and refund identity remain owned
 * by the supplied context.
 */
export const rateLimit = ({
  context,
  duration,
  errorResponse = DEFAULT_RATE_LIMIT_ERROR_RESPONSE,
  generator,
  max,
  additionalBudgets,
  onLimit,
  budget: observeBudget,
  skip = () => false,
}: RateLimitOptions): Middleware => {
  context.init({ duration });
  ownedContexts.add(context);

  const middleware: Middleware = async (ctx, inner) => {
    // The validated development-only switch applies to every HTTP budget,
    // including dedicated budgets whose route policy does not define a bypass.
    if (
      env.E2E_DISABLE_AUTH_RATE_LIMIT ||
      (await skip(ctx.request, ctx.routeEntry))
    ) {
      return await inner();
    }

    const key = await generator(ctx.request, ctx.server);
    const requestMax = typeof max === "number" ? max : await max(ctx.request);
    const budgets = [
      { key, max: requestMax, duration },
      ...(additionalBudgets === undefined
        ? []
        : await additionalBudgets(ctx.request)),
    ];
    const charges: RateLimitCharge[] = [];
    const refund = async () => {
      const refunded = charges.splice(0);
      await Promise.all(
        refunded.map(
          async ({ key: refundKey, windowStart }) =>
            await context.decrement(refundKey, windowStart),
        ),
      );
    };
    try {
      // Rejected attempts consume earlier windows; later windows are untouched.
      for (const budget of budgets) {
        let charged: Awaited<ReturnType<typeof chargeWindow>>;
        try {
          charged = await chargeWindow({ context, budget, set: ctx.set });
        } catch (error) {
          // The counter store failed, not the caller: the windows this request
          // already charged come back before the failure propagates.
          await refund();
          throw error;
        }
        const { charge, exceeded } = charged;
        charges.push(charge);
        if (exceeded) {
          if (observeBudget !== undefined) {
            recordBudgetRejection({
              ...(typeof observeBudget === "function"
                ? observeBudget(budget.key)
                : observeBudget),
              windowMs: budget.duration,
            });
          }
          onLimit?.({ key: budget.key, duration: budget.duration });
          return toResponse(status(429, errorResponse), ctx.set);
        }
      }
      try {
        return await inner();
      } catch (error) {
        // The caller spent a request refused for its input; a handler fault
        // is the server's, so its charge comes back.
        if (!isEarlyHttpFailure(error)) {
          await refund();
        }
        throw error;
      }
    } finally {
      await Promise.all(
        charges.map(
          async ({ key: chargedKey }) => await context.complete(chargedKey),
        ),
      );
    }
  };
  rateLimitMiddleware.add(middleware);
  return asRouteBudget(middleware);
};
