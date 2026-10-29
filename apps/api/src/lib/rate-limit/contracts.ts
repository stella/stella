import type { RouteEntry } from "@/api/http/route";
import type { BudgetObservation } from "@/api/lib/rate-limit/budget-observability";

type MaybePromise<T> = T | Promise<T>;

type RateLimitCounter = {
  count: number;
  nextReset: Date;
  start: number;
};

export type RateLimitContextConfig = {
  duration: number;
};

export type RateLimitContext = {
  /** Drop refund identity after response completion, preserving the quota count. */
  complete: (key: string) => MaybePromise<void>;
  decrement: (key: string, windowStart?: number) => MaybePromise<void>;
  increment: (
    key: string,
    duration?: number,
    requestTime?: number,
  ) => MaybePromise<RateLimitCounter>;
  init: (options: RateLimitContextConfig) => void;
  kill: () => MaybePromise<void>;
};

export type ReadableRateLimitContext = RateLimitContext & {
  /** Observe the active window without charging or allocating a refund identity. */
  read: (key: string) => MaybePromise<RateLimitCounter | null>;
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
type RateLimitErrorResponse = string | object;

export type RateLimitOptions = {
  context: RateLimitContext;
  duration: number;
  errorResponse?: RateLimitErrorResponse;
  /** Shared capacity exhaustion is service unavailability, not a caller quota. */
  refusalStatus?: 429 | 503;
  generator: RateLimitGenerator;
  max: number | ((request: Request) => MaybePromise<number>);
  additionalBudgets?: (
    request: Request,
  ) => MaybePromise<readonly RateLimitBudget[]>;
  budget?: BudgetObservation | ((key: string) => BudgetObservation);
  onLimit?: (limited: { key: string; duration: number }) => void;
  /** Leave the request uncharged; it sees the matched route, if any. */
  skip?: (
    request: Request,
    entry: RouteEntry | undefined,
  ) => MaybePromise<boolean>;
};

export type RateLimitBudget = {
  key: string;
  max: number;
  duration: number;
};
