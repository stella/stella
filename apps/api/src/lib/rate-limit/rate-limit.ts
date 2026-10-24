import { panic } from "better-result";
import { type Context, Elysia } from "elysia";

import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import {
  type RateLimitClientAddressOptions,
  resolveRateLimitClientAddress,
} from "@/api/lib/client-ip";
import { isResponseValidationError } from "@/api/lib/errors/response-validation";
import { resolveResponseStatus } from "@/api/lib/observability/response-status";
import { recordBudgetRejection } from "@/api/lib/rate-limit/budget-observability";
import type {
  RateLimitBudget,
  RateLimitContext,
  RateLimitContextConfig,
  RateLimitErrorResponse,
  RateLimitGenerator,
  RateLimitOptions,
  ReadableRateLimitContext,
  RequestIpServer,
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

type RateLimitResponseSet = Context["set"];

/** One window a request was charged in; refunds touch only that window. */
type RateLimitCharge = { key: string; windowStart: number };

type RateLimitRequestState =
  | { type: "counted"; charges: RateLimitCharge[] }
  | { type: "counted_early_failure"; charges: RateLimitCharge[] }
  | { type: "limited"; charges: RateLimitCharge[] }
  | { type: "refunded" }
  | { type: "skipped" };

type CompleteRateLimitRequestOptions = {
  context: RateLimitContext;
  requestState: WeakMap<Request, RateLimitRequestState>;
  request: Request;
};

const completeRateLimitRequest = async ({
  context,
  requestState,
  request,
}: CompleteRateLimitRequestOptions) => {
  const state = requestState.get(request);
  if (
    state?.type === "counted" ||
    state?.type === "counted_early_failure" ||
    state?.type === "limited"
  ) {
    await Promise.all(
      state.charges.map(async ({ key }) => await context.complete(key)),
    );
  }
  requestState.delete(request);
};

type RateLimitApplicationPhase = "before_handler" | "early_failure";

export const DEFAULT_RATE_LIMIT_ERROR_RESPONSE = "rate-limit reached";

/**
 * Before-handle hooks `rateLimit` installed. The composed-route census asserts
 * every `/v1` route carries one, which a hook's name cannot guarantee.
 */
const rateLimitHooks = new WeakSet<object>();

/** Whether a mounted route's before-handle hook came out of `rateLimit`. */
export const isRateLimitHook = (hook: unknown): boolean =>
  typeof hook === "function" && rateLimitHooks.has(hook);

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
  set: RateLimitResponseSet;
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

const rateLimitErrorStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("status" in error && typeof error.status === "number") {
    return error.status;
  }
  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return undefined;
};

const isEarlyFailureStatus = (statusCode: number): boolean =>
  statusCode === 400 || statusCode === 404 || statusCode === 422;

/** Charge one window, write its headers, and report whether it is exhausted. */
const chargeWindow = async ({
  context,
  budget,
  set,
}: {
  context: RateLimitContext;
  budget: RateLimitBudget;
  set: RateLimitResponseSet;
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
 * Stella's Elysia adapter for its replica-safe rate-limit contexts.
 *
 * Fixed-window policies may be bound to the authenticated client. Counter
 * storage, outage behavior, and refund identity remain owned by
 * the supplied context rather than by framework middleware.
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
}: RateLimitOptions) => {
  context.init({ duration });
  const requestState = new WeakMap<Request, RateLimitRequestState>();

  // Each registration owns a route subtree even when two subtrees share the
  // same counter key and limits. Keeping the plugin unnamed prevents Elysia's
  // named-plugin deduplication from dropping either scoped hook.
  const plugin = new Elysia();

  const applyRateLimit = async ({
    phase,
    request,
    server,
    set,
  }: {
    phase: RateLimitApplicationPhase;
    request: Request;
    server: RequestIpServer | null;
    set: RateLimitResponseSet;
  }): Promise<RateLimitErrorResponse | undefined> => {
    // The validated development-only switch applies to every HTTP budget,
    // including dedicated budgets whose route policy does not define a bypass.
    if (env.E2E_DISABLE_AUTH_RATE_LIMIT || (await skip(request))) {
      requestState.set(request, { type: "skipped" });
      return undefined;
    }

    const key = await generator(request, server);
    const requestMax = typeof max === "number" ? max : await max(request);
    const budgets = [
      { key, max: requestMax, duration },
      ...(additionalBudgets === undefined
        ? []
        : await additionalBudgets(request)),
    ];
    const charges: RateLimitCharge[] = [];
    // Recorded before the first increment, so a later window that throws still
    // leaves every earlier charge to the error and completion hooks.
    requestState.set(
      request,
      phase === "before_handler"
        ? { type: "counted", charges }
        : { type: "counted_early_failure", charges },
    );
    // Rejected attempts consume earlier windows; later windows are untouched.
    for (const budget of budgets) {
      const { charge, exceeded } = await chargeWindow({ context, budget, set });
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
        requestState.set(request, { type: "limited", charges });
        set.status = 429;
        return errorResponse;
      }
    }
    return undefined;
  };

  const beforeHandle = async ({
    request,
    server,
    set,
  }: {
    request: Request;
    server: RequestIpServer | null;
    set: RateLimitResponseSet;
  }) =>
    await applyRateLimit({
      phase: "before_handler",
      request,
      server,
      set,
    });
  rateLimitHooks.add(beforeHandle);
  plugin.onBeforeHandle({ as: "scoped" }, beforeHandle);

  plugin.onError(
    { as: "scoped" },
    async ({ code, error, request, server, set }) => {
      const state = requestState.get(request);
      if (state !== undefined) {
        switch (state.type) {
          case "counted":
            requestState.set(request, { type: "refunded" });
            await Promise.all(
              state.charges.map(
                async ({ key, windowStart }) =>
                  await context.decrement(key, windowStart),
              ),
            );
            return undefined;
          case "counted_early_failure":
          case "limited":
          case "refunded":
          case "skipped":
            return undefined;
          default: {
            state satisfies never;
            return panic(`Unhandled state: ${String(state)}`);
          }
        }
      }

      const currentStatus =
        typeof set.status === "number" ? set.status : undefined;
      const failedBeforeRateLimit =
        code === "NOT_FOUND" ||
        code === "PARSE" ||
        (code === "VALIDATION" && !isResponseValidationError(error)) ||
        currentStatus === 404 ||
        rateLimitErrorStatus(error) === 404;

      if (failedBeforeRateLimit) {
        return await applyRateLimit({
          phase: "early_failure",
          request,
          server,
          set,
        });
      }
      return undefined;
    },
  );

  plugin.mapResponse({ as: "scoped" }, async (lifecycle) => {
    const { request, responseValue, server, set } = lifecycle;
    const handledError = Object.hasOwn(lifecycle, "code");
    const statusCode = resolveResponseStatus({
      response: responseValue,
      set,
    });
    const state = requestState.get(request);

    if (state === undefined) {
      if (handledError && isEarlyFailureStatus(statusCode)) {
        const rateLimitResponse = await applyRateLimit({
          phase: "early_failure",
          request,
          server,
          set,
        });
        if (rateLimitResponse !== undefined) {
          const headers = new Headers();
          for (const [name, value] of Object.entries(set.headers)) {
            headers.set(name, String(value));
          }
          // This branch builds the Response itself, so it owns the
          // content-type Elysia would otherwise derive from the return value.
          const isJson = typeof rateLimitResponse !== "string";
          if (isJson) {
            headers.set("content-type", "application/json");
          }
          return new Response(
            isJson ? JSON.stringify(rateLimitResponse) : rateLimitResponse,
            { headers, status: 429 },
          );
        }
      }
      return undefined;
    }

    switch (state.type) {
      case "counted":
        if (handledError) {
          requestState.set(request, { type: "refunded" });
          await Promise.all(
            state.charges.map(
              async ({ key, windowStart }) =>
                await context.decrement(key, windowStart),
            ),
          );
        }
        return undefined;
      case "counted_early_failure":
      case "limited":
      case "refunded":
      case "skipped":
        return undefined;
      default: {
        state satisfies never;
        return panic(`Unhandled state: ${String(state)}`);
      }
    }
  });

  plugin.onAfterResponse(
    { as: "scoped" },
    async ({ request }) =>
      await completeRateLimitRequest({ context, requestState, request }),
  );

  plugin.onStop(async () => {
    await context.kill();
  });

  return plugin;
};
