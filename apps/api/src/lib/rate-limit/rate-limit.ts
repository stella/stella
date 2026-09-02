import { Elysia, type Context } from "elysia";

import { resolveResponseStatus } from "@/api/lib/observability/response-status";

type MaybePromise<T> = T | Promise<T>;

export type RateLimitCounter = {
  count: number;
  nextReset: Date;
  start: number;
};

export type RateLimitContextConfig = {
  duration: number;
};

export type RateLimitContext = {
  decrement: (key: string) => MaybePromise<void>;
  increment: (
    key: string,
    duration?: number,
    requestTime?: number,
  ) => MaybePromise<RateLimitCounter>;
  init: (options: RateLimitContextConfig) => void;
  kill: () => MaybePromise<void>;
};

export type RequestIpServer = {
  requestIP: (request: Request) => { address: string } | null;
};

export type RateLimitGenerator = (
  request: Request,
  server: RequestIpServer | null,
) => MaybePromise<string>;

/**
 * Body served with a 429. A string goes out as `text/plain`; an object is
 * serialized as JSON, so a route whose clients parse every response into a
 * protocol envelope (JSON-RPC) can answer in that envelope instead of prose.
 */
export type RateLimitErrorResponse = string | object;

export type RateLimitOptions = {
  context: RateLimitContext;
  duration: number;
  errorResponse?: RateLimitErrorResponse;
  generator: RateLimitGenerator;
  max: number;
  skip?: (request: Request) => MaybePromise<boolean>;
};

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
    scopedRateLimitKey(scope, request, server);

export const scopedRateLimitKey = (
  scope: string,
  request: Request,
  server: RequestIpServer | null,
): string => {
  const address = server?.requestIP(request)?.address;
  return address ? `${scope}:${address}` : scope;
};

/**
 * In-memory rate limiting. Each process maintains its own
 * counters; with multiple instances, a client may get up
 * to N× the configured limit. The hard global limit is
 * enforced at the network edge.
 */
export class InMemoryRateLimitContext implements RateLimitContext {
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

  increment(key: string, duration?: number, requestTime?: number) {
    const effectiveDuration = duration ?? this.durationMs;
    const now = requestTime ?? Date.now();
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

  decrement(key: string) {
    const now = Date.now();
    const entry = this.store.get(key);
    if (entry && entry.expiresAt > now && entry.count > 0) {
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
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}

type RateLimitResponseSet = Context["set"];

type RateLimitRequestState =
  | { type: "counted"; key: string }
  | { type: "counted_early_failure" }
  | { type: "limited" }
  | { type: "refunded" }
  | { type: "skipped" };

type RateLimitApplicationPhase = "before_handler" | "early_failure";

const DEFAULT_RATE_LIMIT_ERROR_RESPONSE = "rate-limit reached";

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
  set.headers["RateLimit-Limit"] = String(max);
  set.headers["RateLimit-Remaining"] = String(remaining);
  set.headers["RateLimit-Reset"] = String(reset);
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

const isResponseValidationError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "type" in error &&
  error.type === "response";

const isEarlyFailureStatus = (statusCode: number): boolean =>
  statusCode === 400 || statusCode === 404 || statusCode === 422;

/**
 * Stella's Elysia adapter for its replica-safe rate-limit contexts.
 *
 * The adapter deliberately exposes only the static fixed-window policy Stella
 * uses. Counter storage, outage behavior, and refund identity remain owned by
 * the supplied context rather than by framework middleware.
 */
export const rateLimit = ({
  context,
  duration,
  errorResponse = DEFAULT_RATE_LIMIT_ERROR_RESPONSE,
  generator,
  max,
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
    if (await skip(request)) {
      requestState.set(request, { type: "skipped" });
      return undefined;
    }

    const key = await generator(request, server);
    const { count, nextReset } = await context.increment(
      key,
      duration,
      Date.now(),
    );
    const remaining = Math.max(max - count, 0);
    const reset = Math.max(
      0,
      Math.ceil((nextReset.getTime() - Date.now()) / 1000),
    );
    const exceeded = count > max;

    writeRateLimitHeaders({
      max,
      remaining,
      reset,
      retryAfter: exceeded,
      set,
    });

    if (exceeded) {
      requestState.set(request, { type: "limited" });
      set.status = 429;
      return errorResponse;
    }

    requestState.set(
      request,
      phase === "before_handler"
        ? { type: "counted", key }
        : { type: "counted_early_failure" },
    );
    return undefined;
  };

  plugin.onBeforeHandle(
    { as: "scoped" },
    async ({ request, server, set }) =>
      await applyRateLimit({
        phase: "before_handler",
        request,
        server,
        set,
      }),
  );

  plugin.onError(
    { as: "scoped" },
    async ({ code, error, request, server, set }) => {
      const state = requestState.get(request);
      if (state !== undefined) {
        switch (state.type) {
          case "counted":
            requestState.set(request, { type: "refunded" });
            await context.decrement(state.key);
            return undefined;
          case "counted_early_failure":
          case "limited":
          case "refunded":
          case "skipped":
            return undefined;
          default: {
            const unreachable: never = state;
            return unreachable;
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
          await context.decrement(state.key);
        }
        return undefined;
      case "counted_early_failure":
      case "limited":
      case "refunded":
      case "skipped":
        return undefined;
      default: {
        state satisfies never;
        return undefined;
      }
    }
  });

  plugin.onStop(async () => {
    await context.kill();
  });

  return plugin;
};
