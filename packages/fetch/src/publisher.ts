import { Result, TaggedError } from "better-result";

import type { TransportRequestInit } from "./index";

const ROBOTS_MAX_BYTES = 512 * 1024;
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const ROBOTS_RETRY_MS = 60 * 1000;
const DEFAULT_MINIMUM_INTERVAL_MS = 1000;
const MAX_CRAWL_DELAY_MS = 60_000;
const ROBOTS_LOAD_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const PRODUCT_TOKEN = "Stella";
// Robots rules are evaluated for PRODUCT_TOKEN, so every request carries
// this agent and callers cannot send one the rules were not checked for.
const PUBLISHER_USER_AGENT = `${PRODUCT_TOKEN}/1.0 (+https://stll.app)`;

export type PublisherPolicy =
  { type: "obey" } | { type: "licensed"; basis: string; evidenceUrl: string };
export type PublisherRobotsDecision =
  | "allowed"
  | "allow_all_4xx"
  | "robots_disallowed"
  | "agent_excluded"
  | "robots_unavailable"
  | "licensed_bypass";

type RefusalFields = {
  message: string;
  url: string;
  origin: string;
};
export class RobotsDisallowedError extends TaggedError(
  "robots_disallowed",
)<RefusalFields> {}
export class AgentExcludedError extends TaggedError(
  "agent_excluded",
)<RefusalFields> {}
export class RobotsUnavailableError extends TaggedError("robots_unavailable")<
  RefusalFields & { cause?: unknown }
> {}
export class CrawlDelayUnsupportedError extends TaggedError(
  "crawl_delay_unsupported",
)<RefusalFields & { crawlDelayMs: number; maximumMs: number }> {}
export class PublisherRedirectLimitError extends TaggedError(
  "publisher_redirect_limit",
)<RefusalFields> {}
export class PublisherTargetRefusedError extends TaggedError(
  "publisher_target_refused",
)<RefusalFields & { cause: unknown }> {}
export class PublisherBodyNotReplayableError extends TaggedError(
  "publisher_body_not_replayable",
)<RefusalFields> {}
export class PublisherRequestAbortedError extends TaggedError(
  "publisher_request_aborted",
)<RefusalFields & { cause: unknown }> {}
/** A licensed bypass is evidence that must be recorded; without a sink it is refused. */
export class PublisherBypassUnauditedError extends TaggedError(
  "publisher_bypass_unaudited",
)<RefusalFields & { cause: unknown }> {}
export type PublisherPolicyError =
  | RobotsDisallowedError
  | AgentExcludedError
  | RobotsUnavailableError
  | CrawlDelayUnsupportedError
  | PublisherRedirectLimitError
  | PublisherTargetRefusedError
  | PublisherBodyNotReplayableError
  | PublisherRequestAbortedError
  | PublisherBypassUnauditedError;

export type PublisherFetchResult = {
  response: Response;
  robotsDecision: PublisherRobotsDecision;
  delayAppliedMs: number;
};

export type PublisherTelemetry = {
  event: "publisher_fetch_policy_bypass";
  url: string;
  origin: string;
  refusal: PublisherPolicyError;
  policy: PublisherPolicy;
  delayMs: number;
};

type Clock = {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};
type PublisherTarget = { url: URL };
type PublisherFetcher<Target extends PublisherTarget> = (
  target: Target,
  init?: TransportRequestInit,
) => Promise<Response>;
type PublisherFetcherOptions<Target extends PublisherTarget> = {
  validateTarget: (url: URL) => Promise<Result<Target, unknown>>;
  fetcher: PublisherFetcher<Target>;
  clock?: Clock;
  robotsTtlMs?: number;
  robotsRetryMs?: number;
  defaultMinimumIntervalMs?: number;
  robotsLoadTimeoutMs?: number;
  /**
   * Audit sink for licensed bypasses, awaited before the bypass proceeds;
   * without it, or when it throws or rejects, the bypass is refused.
   */
  onTelemetry?: (event: PublisherTelemetry) => void | Promise<void>;
};
type PublisherFetchOptions = {
  init?: Omit<TransportRequestInit, "redirect">;
  policy?: PublisherPolicy;
};

type CompiledPattern = {
  anchored: boolean;
  segments: { literal: string; prefix: number[] }[];
  specificity: number;
};
type Rule = {
  type: "allow" | "disallow";
  pattern: string;
  compiled?: CompiledPattern;
};
type Group = { agents: string[]; rules: Rule[]; crawlDelayMs?: number };
type RobotsState =
  | { type: "rules"; groups: Group[] }
  | { type: "allow-all" }
  | { type: "unavailable"; cause?: unknown };
type CachedRobots = { expiresAt: number; state: RobotsState };

/** Every robots refusal a licensed policy may bypass, each only with an audit record. */
export type PublisherBypassableRefusal =
  | RobotsUnavailableError
  | CrawlDelayUnsupportedError
  | AgentExcludedError
  | RobotsDisallowedError;

const publisherPolicyFor = (
  state: RobotsState,
  url: URL,
  defaultMinimumIntervalMs: number,
): {
  decision?: PublisherRobotsDecision;
  intervalMs: number;
  refusal?: PublisherBypassableRefusal;
} => {
  if (state.type === "unavailable") {
    return {
      intervalMs: defaultMinimumIntervalMs,
      refusal: new RobotsUnavailableError({
        message: "robots.txt is unavailable",
        url: url.href,
        origin: url.origin,
        cause: state.cause,
      }),
    };
  }
  if (state.type === "allow-all") {
    return {
      decision: "allow_all_4xx",
      intervalMs: defaultMinimumIntervalMs,
    };
  }
  const evaluated = evaluatePublisherRobots(
    state.groups,
    PRODUCT_TOKEN,
    `${url.pathname}${url.search}`,
  );
  if (evaluated.crawlDelayMs > MAX_CRAWL_DELAY_MS) {
    return {
      intervalMs: evaluated.crawlDelayMs,
      refusal: new CrawlDelayUnsupportedError({
        message: "robots.txt crawl delay exceeds the supported maximum",
        url: url.href,
        origin: url.origin,
        crawlDelayMs: evaluated.crawlDelayMs,
        maximumMs: MAX_CRAWL_DELAY_MS,
      }),
    };
  }
  let refusal: AgentExcludedError | RobotsDisallowedError | undefined;
  if (!evaluated.allowed) {
    refusal = evaluated.agentExcluded
      ? new AgentExcludedError({
          message: "robots.txt excludes the stella agent",
          url: url.href,
          origin: url.origin,
        })
      : new RobotsDisallowedError({
          message: "robots.txt disallows this URL",
          url: url.href,
          origin: url.origin,
        });
  }
  return {
    intervalMs: Math.max(defaultMinimumIntervalMs, evaluated.crawlDelayMs),
    ...(refusal ? { refusal } : {}),
  };
};

const normalizeOctets = (value: string) => {
  const percentNormalized = value.replaceAll(/%[\da-f]{2}/giu, (encoded) => {
    const octet = Number.parseInt(encoded.slice(1), 16);
    const character = String.fromCodePoint(octet);
    return /^[A-Za-z0-9._~-]$/u.test(character)
      ? character
      : `%${encoded.slice(1).toUpperCase()}`;
  });
  let normalized = "";
  for (const character of percentNormalized) {
    if ((character.codePointAt(0) ?? Number.POSITIVE_INFINITY) <= 0x7f) {
      normalized += character;
      continue;
    }
    for (const octet of new TextEncoder().encode(character)) {
      normalized += `%${octet.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return normalized;
};

const parseRobots = (body: string): Group[] => {
  const groups: Group[] = [];
  let current: Group | undefined;
  let sawRule = false;
  // RFC 9309 ends a line with CR, LF or CRLF.
  for (const rawLine of body.split(/\r\n|\r|\n/u)) {
    const comment = rawLine.indexOf("#");
    const line = rawLine.slice(0, comment === -1 ? undefined : comment).trim();
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || sawRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRule = false;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current || current.agents.length === 0) {
      continue;
    }
    if (field === "allow" || field === "disallow") {
      sawRule = true;
      if (value !== "") {
        current.rules.push({
          type: field,
          pattern: value,
          compiled: compilePattern(value),
        });
      }
      continue;
    }
    if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        sawRule = true;
        current.crawlDelayMs = seconds * 1000;
      }
    }
  }
  return groups;
};

// RFC 9309 matches the product token case-insensitively by equality and
// combines every matching group; wildcard groups apply only when none match.
const selectedGroups = (groups: Group[], productToken: string) => {
  const token = productToken.toLowerCase();
  const named = groups.filter(({ agents }) => agents.includes(token));
  return named.length > 0
    ? named
    : groups.filter(({ agents }) => agents.includes("*"));
};

const compilePattern = (pattern: string): CompiledPattern => {
  const normalized = normalizeOctets(pattern);
  const anchored = normalized.endsWith("$");
  const body = anchored ? normalized.slice(0, -1) : normalized;
  const segments = body.split("*").map((literal) => {
    const prefix = Array.from({ length: literal.length }, () => 0);
    for (let index = 1, matched = 0; index < literal.length; index += 1) {
      while (matched > 0 && literal[index] !== literal[matched]) {
        matched = prefix.at(matched - 1) ?? 0;
      }
      if (literal[index] === literal[matched]) {
        matched += 1;
      }
      prefix[index] = matched;
    }
    return { literal, prefix };
  });
  return {
    anchored,
    segments,
    // RFC 9309 ranks rules by the octets of the rule as written, wildcards
    // included; a normalized %XX escape is one octet.
    specificity: body.replaceAll(/%[\dA-F]{2}/gu, "%").length,
  };
};

const findSegment = (
  value: string,
  start: number,
  segment: CompiledPattern["segments"][number],
) => {
  if (segment.literal.length === 0) {
    return start;
  }
  for (let index = start, matched = 0; index < value.length; index += 1) {
    while (matched > 0 && value[index] !== segment.literal[matched]) {
      matched = segment.prefix.at(matched - 1) ?? 0;
    }
    if (value[index] === segment.literal[matched]) {
      matched += 1;
    }
    if (matched === segment.literal.length) {
      return index - matched + 1;
    }
  }
  return -1;
};

const wildcardMatches = (compiled: CompiledPattern, value: string) => {
  const first = compiled.segments.at(0);
  if (!first) {
    return false;
  }
  if (!value.startsWith(first.literal)) {
    return false;
  }
  let position = first.literal.length;
  const lastIndex = compiled.segments.length - 1;
  for (let index = 1; index < lastIndex; index += 1) {
    const segment = compiled.segments.at(index);
    if (!segment) {
      return false;
    }
    const found = findSegment(value, position, segment);
    if (found === -1) {
      return false;
    }
    position = found + segment.literal.length;
  }
  if (lastIndex === 0) {
    return !compiled.anchored || position === value.length;
  }
  const last = compiled.segments.at(lastIndex);
  if (!last) {
    return false;
  }
  if (compiled.anchored) {
    const start = value.length - last.literal.length;
    return start >= position && value.endsWith(last.literal);
  }
  return findSegment(value, position, last) !== -1;
};

export const evaluatePublisherRobots = (
  groups: Group[],
  productToken: string,
  path: string,
) => {
  const selected = selectedGroups(groups, productToken);
  const named = selected.some((group) =>
    group.agents.some(
      (agent) => agent !== "*" && productToken.toLowerCase().startsWith(agent),
    ),
  );
  const rules = selected.flatMap(({ rules: groupRules }) => groupRules);
  const normalizedPath = normalizeOctets(path);
  const matches = rules
    .map((rule) => ({
      ...rule,
      compiled: rule.compiled ?? compilePattern(rule.pattern),
    }))
    .filter(({ compiled }) => wildcardMatches(compiled, normalizedPath))
    .map((rule) => ({
      ...rule,
      specificity: rule.compiled.specificity,
    }));
  const longest = Math.max(
    -1,
    ...matches.map(({ specificity }) => specificity),
  );
  const winners = matches.filter(({ specificity }) => specificity === longest);
  const allowed = longest < 0 || winners.some(({ type }) => type === "allow");
  const agentExcluded =
    named &&
    rules.some(({ type, pattern }) => type === "disallow" && pattern === "/") &&
    !allowed;
  return {
    allowed,
    agentExcluded,
    crawlDelayMs: Math.max(
      0,
      ...selected.map(({ crawlDelayMs }) => crawlDelayMs ?? 0),
    ),
  };
};

const abortReason = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");

// Detaches its listener once either side settles, so a long-lived caller
// signal does not retain a listener (and its race result) per request.
const raceAbort = async <T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  if (!signal) {
    return await work;
  }
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(abortReason(signal));
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

export class PublisherBodyLimitError extends TaggedError(
  "publisher_body_limit",
)<{ message: string; url: string; maxBytes: number }> {}

type ReadBoundedBodyOptions = { maxBytes: number; signal: AbortSignal };

// Rejects when the signal aborts or the stream errors; the reader is
// cancelled on every exit so an oversized or stalled body releases its
// connection.
export const readBoundedBody = async (
  response: Response,
  { maxBytes, signal }: ReadBoundedBodyOptions,
): Promise<Result<Uint8Array, PublisherBodyLimitError>> => {
  if (!response.body) {
    return Result.ok(new Uint8Array());
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await raceAbort(reader.read(), signal);
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > maxBytes) {
        exceeded = true;
        break;
      }
      chunks.push(next.value);
    }
  } finally {
    try {
      await raceAbort(reader.cancel(), signal);
    } finally {
      reader.releaseLock();
    }
  }
  if (exceeded) {
    return Result.err(
      new PublisherBodyLimitError({
        message: "response body exceeds the byte limit",
        url: response.url,
        maxBytes,
      }),
    );
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Result.ok(bytes);
};

const readRobotsText = async (response: Response, signal: AbortSignal) => {
  const bytes = await readBoundedBody(response, {
    maxBytes: ROBOTS_MAX_BYTES,
    signal,
  });
  return Result.isError(bytes)
    ? Result.err(
        new RobotsUnavailableError({
          message: "robots.txt exceeds the byte limit",
          url: response.url || "robots.txt",
          origin: response.url ? new URL(response.url).origin : "unknown",
        }),
      )
    : Result.ok(new TextDecoder().decode(bytes.value));
};

// The Fetch standard's redirect statuses; 300 and 304 are returned as is.
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);
const isRedirect = (response: Response) =>
  REDIRECT_STATUSES.has(response.status);

const validatePublisherTarget = async <Target extends PublisherTarget>(
  url: URL,
  validateTarget: (url: URL) => Promise<Result<Target, unknown>>,
) => {
  const validated = await validateTarget(url);
  return Result.isError(validated)
    ? Result.err(
        new PublisherTargetRefusedError({
          message: "Publisher target was refused",
          url: url.href,
          origin: url.origin,
          cause: validated.error,
        }),
      )
    : validated;
};

type RedirectedRequestInitOptions = {
  response: Response;
  currentUrl: URL;
  nextUrl: URL;
  requestInit: Omit<TransportRequestInit, "redirect"> | undefined;
  headers: Headers;
};

const redirectedRequestInit = ({
  response,
  currentUrl,
  nextUrl,
  requestInit,
  headers,
}: RedirectedRequestInitOptions) => {
  const method = requestInit?.method?.toUpperCase() ?? "GET";
  const dropBody =
    (response.status === 303 && method !== "HEAD") ||
    ((response.status === 301 || response.status === 302) && method === "POST");
  // A stream body was consumed by the first request; any redirect that keeps
  // the body would resend nothing.
  if (!dropBody && requestInit?.body instanceof ReadableStream) {
    return Result.err(
      new PublisherBodyNotReplayableError({
        message: "Publisher redirect requires a replayable request body",
        url: currentUrl.href,
        origin: currentUrl.origin,
      }),
    );
  }
  const redirectedHeaders = new Headers(headers);
  if (nextUrl.origin !== currentUrl.origin) {
    for (const name of ["Authorization", "Cookie", "Proxy-Authorization"]) {
      redirectedHeaders.delete(name);
    }
  }
  if (dropBody) {
    for (const name of [
      "Content-Type",
      "Content-Length",
      "Content-Encoding",
      "Content-Language",
      "Content-Location",
    ]) {
      redirectedHeaders.delete(name);
    }
  }
  return Result.ok({
    ...requestInit,
    ...(dropBody ? { body: null, method: "GET" } : {}),
    headers: redirectedHeaders,
  });
};

// Unread response bodies hold their connection open until cancelled.
// Without a signal the caller chose no deadline, so cancel is awaited as is.
const discardBody = async (
  response: Response,
  signal: AbortSignal | undefined,
) =>
  Result.tryPromise(async () =>
    raceAbort(response.body?.cancel() ?? Promise.resolve(), signal),
  );

type LoadRobotsOptions<Target extends PublisherTarget> = {
  fetcher: PublisherFetcher<Target>;
  validateTarget: PublisherFetcherOptions<Target>["validateTarget"];
  origin: string;
  now: () => number;
  robotsTtlMs: number;
  robotsRetryMs: number;
  robotsLoadTimeoutMs: number;
};

const loadRobots = async <Target extends PublisherTarget>({
  fetcher,
  validateTarget,
  origin,
  now,
  robotsTtlMs,
  robotsRetryMs,
  robotsLoadTimeoutMs,
}: LoadRobotsOptions<Target>): Promise<
  | { type: "cacheable"; robots: CachedRobots }
  | { type: "refused"; state: RobotsState }
> => {
  const deadline = AbortSignal.timeout(robotsLoadTimeoutMs);
  let target = new URL("/robots.txt", origin);
  let finalResponse: Response | undefined;
  let failure: unknown;
  for (let redirects = 0; ; redirects += 1) {
    const requestTarget = target;
    // Raced as well as signalled: a validator or transport that ignores the
    // signal must not hold the shared load past its deadline.
    const checked = await Result.tryPromise(async () =>
      raceAbort(
        validatePublisherTarget(requestTarget, validateTarget),
        deadline,
      ),
    );
    if (Result.isError(checked)) {
      failure = checked.error.cause;
      break;
    }
    const validated = checked.value;
    if (Result.isError(validated)) {
      failure = validated.error;
      break;
    }
    const fetched = await Result.tryPromise(async () =>
      raceAbort(
        fetcher(validated.value, {
          headers: { "User-Agent": PUBLISHER_USER_AGENT },
          redirect: "manual",
          signal: deadline,
        }),
        deadline,
      ),
    );
    if (Result.isError(fetched)) {
      failure = fetched.error.cause;
      break;
    }
    if (!isRedirect(fetched.value)) {
      finalResponse = fetched.value;
      break;
    }
    const cancelled = await discardBody(fetched.value, deadline);
    if (Result.isError(cancelled)) {
      failure = cancelled.error.cause;
      break;
    }
    const location = fetched.value.headers.get("location");
    if (!location || redirects >= MAX_REDIRECTS) {
      failure = new RobotsUnavailableError({
        message: location
          ? "robots.txt exceeded the redirect limit"
          : "robots.txt redirect has no location",
        url: requestTarget.href,
        origin,
      });
      break;
    }
    if (!URL.canParse(location, requestTarget.href)) {
      failure = new RobotsUnavailableError({
        message: "robots.txt redirect location is invalid",
        url: requestTarget.href,
        origin,
      });
      break;
    }
    target = new URL(location, requestTarget);
  }
  if (!finalResponse) {
    if (PublisherTargetRefusedError.is(failure)) {
      return {
        type: "refused",
        state: { type: "unavailable", cause: failure },
      };
    }
    return {
      type: "cacheable",
      robots: {
        state: { type: "unavailable", cause: failure },
        expiresAt: now() + robotsRetryMs,
      },
    };
  }
  if (finalResponse.status >= 400) {
    const discarded = await discardBody(finalResponse, deadline);
    if (Result.isError(discarded)) {
      return {
        type: "cacheable",
        robots: {
          state: { type: "unavailable", cause: discarded.error.cause },
          expiresAt: now() + robotsRetryMs,
        },
      };
    }
  }
  if (finalResponse.status >= 400 && finalResponse.status < 500) {
    return {
      type: "cacheable",
      robots: {
        state: { type: "allow-all" },
        expiresAt: now() + robotsTtlMs,
      },
    };
  }
  if (finalResponse.status >= 500) {
    return {
      type: "cacheable",
      robots: {
        state: { type: "unavailable" },
        expiresAt: now() + robotsRetryMs,
      },
    };
  }
  const body = await Result.tryPromise(async () =>
    readRobotsText(finalResponse, deadline),
  );
  if (Result.isError(body)) {
    return {
      type: "cacheable",
      robots: {
        state: {
          type: "unavailable",
          cause: body.error.cause,
        },
        expiresAt: now() + robotsRetryMs,
      },
    };
  }
  if (Result.isError(body.value)) {
    return {
      type: "cacheable",
      robots: {
        state: { type: "unavailable", cause: body.value.error },
        expiresAt: now() + robotsRetryMs,
      },
    };
  }
  return {
    type: "cacheable",
    robots: {
      state: { type: "rules", groups: parseRobots(body.value.value) },
      expiresAt: now() + robotsTtlMs,
    },
  };
};

type RobotsCacheOptions<Target extends PublisherTarget> = Pick<
  LoadRobotsOptions<Target>,
  | "fetcher"
  | "validateTarget"
  | "robotsTtlMs"
  | "robotsRetryMs"
  | "robotsLoadTimeoutMs"
> & { now: () => number };

const createRobotsCache = <Target extends PublisherTarget>(
  options: RobotsCacheOptions<Target>,
) => {
  const settled = new Map<string, CachedRobots>();
  const pending = new Map<string, ReturnType<typeof loadRobots>>();
  return async (origin: string) => {
    const cached = settled.get(origin);
    if (cached && cached.expiresAt > options.now()) {
      return cached.state;
    }
    const activeLoad = pending.get(origin);
    if (activeLoad) {
      const activeResult = await activeLoad;
      if (activeResult.type === "cacheable") {
        return activeResult.robots.state;
      }
    }
    const load = loadRobots({
      ...options,
      origin,
    });
    pending.set(origin, load);
    const loaded = await load;
    if (pending.get(origin) === load) {
      pending.delete(origin);
    }
    if (loaded.type === "refused") {
      return loaded.state;
    }
    settled.set(origin, loaded.robots);
    return loaded.robots.state;
  };
};

const createOriginScheduler = (clock: Clock) => {
  const queues = new Map<string, Promise<void>>();
  const nextAllowedAt = new Map<string, number>();
  return async (origin: string, intervalMs: number, signal?: AbortSignal) => {
    const previous = queues.get(origin) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(
      origin,
      previous.then(async () => current),
    );
    const acquired = await Result.tryPromise(async () =>
      raceAbort(previous, signal),
    );
    if (Result.isError(acquired)) {
      release();
      const cause = acquired.error.cause;
      return await Promise.reject(
        cause instanceof Error
          ? cause
          : new DOMException("The operation was aborted", "AbortError"),
      );
    }
    const delay = Math.max(
      0,
      (nextAllowedAt.get(origin) ?? clock.now()) - clock.now(),
    );
    try {
      if (delay > 0) {
        // An injected sleep may ignore the signal; racing it keeps an
        // aborted caller from holding the origin queue past `finally`.
        await raceAbort(clock.sleep(delay, signal), signal);
      }
      nextAllowedAt.set(origin, clock.now() + intervalMs);
      return delay;
    } finally {
      release();
    }
  };
};

type PublisherRuntime<Target extends PublisherTarget> = {
  fetcher: PublisherFetcher<Target>;
  validateTarget: PublisherFetcherOptions<Target>["validateTarget"];
  robotsFor: (origin: string) => Promise<RobotsState>;
  reserve: (
    origin: string,
    intervalMs: number,
    signal?: AbortSignal,
  ) => Promise<number>;
  defaultMinimumIntervalMs: number;
  onTelemetry: ((event: PublisherTelemetry) => Promise<void>) | undefined;
};

const abortBoundRuntimeBrand = Symbol("abort-bound-publisher-runtime");
type AbortBoundMember<Member> =
  NonNullable<Member> extends (...args: infer Args) => Promise<infer Value>
    ? ((...args: Args) => Promise<Value>) | Extract<Member, undefined>
    : Member;
type AbortBoundPublisherRuntime<Target extends PublisherTarget> = {
  [Key in keyof PublisherRuntime<Target>]: AbortBoundMember<
    PublisherRuntime<Target>[Key]
  >;
} & { readonly [abortBoundRuntimeBrand]: true };

const bindPublisherRuntimeToAbort = <Target extends PublisherTarget>(
  runtime: PublisherRuntime<Target>,
  signal: AbortSignal | undefined,
): AbortBoundPublisherRuntime<Target> => {
  const onTelemetry = runtime.onTelemetry;
  const bound = {
    fetcher: async (...args: Parameters<PublisherRuntime<Target>["fetcher"]>) =>
      await raceAbort(runtime.fetcher(...args), signal),
    validateTarget: async (
      ...args: Parameters<PublisherRuntime<Target>["validateTarget"]>
    ) => await raceAbort(runtime.validateTarget(...args), signal),
    robotsFor: async (
      ...args: Parameters<PublisherRuntime<Target>["robotsFor"]>
    ) => await raceAbort(runtime.robotsFor(...args), signal),
    reserve: async (...args: Parameters<PublisherRuntime<Target>["reserve"]>) =>
      await raceAbort(runtime.reserve(...args), signal),
    defaultMinimumIntervalMs: runtime.defaultMinimumIntervalMs,
    onTelemetry: onTelemetry
      ? async (
          ...args: Parameters<
            NonNullable<PublisherRuntime<Target>["onTelemetry"]>
          >
        ) => await raceAbort(onTelemetry(...args), signal)
      : undefined,
  } satisfies {
    [Key in keyof PublisherRuntime<Target>]: AbortBoundMember<
      PublisherRuntime<Target>[Key]
    >;
  };
  return Object.assign(bound, { [abortBoundRuntimeBrand]: true as const });
};

type WalkState = {
  // A licensed policy authorizes only the origin the caller requested.
  requestedOrigin: string;
  url: URL;
  requestInit: PublisherFetchOptions["init"];
  decision: PublisherRobotsDecision;
  delayAppliedMs: number;
};

const enforcePublisherPolicy = async <Target extends PublisherTarget>(
  state: WalkState,
  options: PublisherFetchOptions,
  runtime: AbortBoundPublisherRuntime<Target>,
): Promise<Result<number, PublisherPolicyError>> => {
  // The robots load is shared; an aborting caller stops waiting for it
  // without cancelling it for the others.
  const signal = state.requestInit?.signal ?? undefined;
  const loaded = await Result.tryPromise(async () =>
    runtime.robotsFor(state.url.origin),
  );
  if (Result.isError(loaded)) {
    return Result.err(
      new PublisherRequestAbortedError({
        message: "Publisher request was aborted while loading robots.txt",
        url: state.url.href,
        origin: state.url.origin,
        cause: loaded.error.cause,
      }),
    );
  }
  const robots = loaded.value;
  if (
    robots.type === "unavailable" &&
    PublisherTargetRefusedError.is(robots.cause)
  ) {
    return Result.err(robots.cause);
  }
  const evaluated = publisherPolicyFor(
    robots,
    state.url,
    runtime.defaultMinimumIntervalMs,
  );
  state.decision = evaluated.decision ?? state.decision;
  const intervalMs = Math.min(evaluated.intervalMs, MAX_CRAWL_DELAY_MS);
  const refusal = evaluated.refusal;
  if (!refusal) {
    return Result.ok(intervalMs);
  }
  const policy =
    state.url.origin === state.requestedOrigin ? options.policy : undefined;
  if (policy?.type !== "licensed") {
    return Result.err(refusal);
  }
  if (runtime.onTelemetry === undefined) {
    return Result.err(
      new PublisherBypassUnauditedError({
        message:
          "A licensed bypass needs an onTelemetry sink to record its evidence",
        url: state.url.href,
        origin: state.url.origin,
        cause: refusal,
      }),
    );
  }
  const sink = runtime.onTelemetry;
  // The bypass proceeds only once its evidence is recorded; a failed or
  // rejected recording refuses it.
  const recorded = await Result.tryPromise(async () => {
    await sink({
      event: "publisher_fetch_policy_bypass",
      url: state.url.href,
      origin: state.url.origin,
      refusal,
      policy,
      delayMs: intervalMs,
    });
  });
  if (Result.isError(recorded)) {
    if (signal?.aborted) {
      return Result.err(
        new PublisherRequestAbortedError({
          message:
            "Publisher request was aborted while recording its licensed bypass",
          url: state.url.href,
          origin: state.url.origin,
          cause: recorded.error.cause,
        }),
      );
    }
    return Result.err(
      new PublisherBypassUnauditedError({
        message: "Recording the licensed bypass failed",
        url: state.url.href,
        origin: state.url.origin,
        cause: recorded.error.cause,
      }),
    );
  }
  state.decision = "licensed_bypass";
  return Result.ok(intervalMs);
};

const redirectLimitResult = (state: WalkState) => {
  const refusal = new PublisherRedirectLimitError({
    message: "publisher response exceeded the redirect limit",
    url: state.url.href,
    origin: state.url.origin,
  });
  return Result.err(refusal);
};

const walkPublisherRedirects = async <Target extends PublisherTarget>(
  input: string | URL,
  options: PublisherFetchOptions,
  runtime: AbortBoundPublisherRuntime<Target>,
): Promise<Result<PublisherFetchResult, PublisherPolicyError>> => {
  const url = new URL(input);
  const state: WalkState = {
    requestedOrigin: url.origin,
    url,
    requestInit: options.init,
    decision: "allowed",
    delayAppliedMs: 0,
  };
  for (let redirects = 0; ; redirects += 1) {
    const signal = state.requestInit?.signal ?? undefined;
    const checked = await Result.tryPromise(async () =>
      validatePublisherTarget(state.url, runtime.validateTarget),
    );
    if (Result.isError(checked)) {
      return Result.err(
        new PublisherRequestAbortedError({
          message: "Publisher request was aborted while validating its target",
          url: state.url.href,
          origin: state.url.origin,
          cause: checked.error.cause,
        }),
      );
    }
    const validated = checked.value;
    if (Result.isError(validated)) {
      return validated;
    }
    state.url = validated.value.url;
    const interval = await enforcePublisherPolicy(state, options, runtime);
    if (Result.isError(interval)) {
      return interval;
    }
    const reserved = await Result.tryPromise(async () =>
      runtime.reserve(
        state.url.origin,
        interval.value,
        state.requestInit?.signal ?? undefined,
      ),
    );
    if (Result.isError(reserved)) {
      return Result.err(
        new PublisherRequestAbortedError({
          message: "Publisher request was aborted while waiting",
          url: state.url.href,
          origin: state.url.origin,
          cause: reserved.error.cause,
        }),
      );
    }
    state.delayAppliedMs += reserved.value;
    const headers = new Headers(state.requestInit?.headers);
    headers.set("User-Agent", PUBLISHER_USER_AGENT);
    const fetched = await Result.tryPromise(async () =>
      runtime.fetcher(validated.value, {
        ...state.requestInit,
        headers,
        redirect: "manual",
      }),
    );
    if (Result.isError(fetched)) {
      if (!signal?.aborted) {
        const cause = fetched.error.cause;
        // The fetcher's own failure propagates unchanged; a non-Error throw
        // is wrapped so callers always receive an Error with the original.
        return await Promise.reject(
          cause instanceof Error
            ? cause
            : new Error("Publisher fetch failed", { cause }),
        );
      }
      return Result.err(
        new PublisherRequestAbortedError({
          message: "Publisher request was aborted while fetching the resource",
          url: state.url.href,
          origin: state.url.origin,
          cause: fetched.error.cause,
        }),
      );
    }
    const response = fetched.value;
    const location = response.headers.get("location");
    if (!isRedirect(response) || !location) {
      return Result.ok({
        response,
        robotsDecision: state.decision,
        delayAppliedMs: state.delayAppliedMs,
      });
    }
    const discarded = await discardBody(
      response,
      state.requestInit?.signal ?? undefined,
    );
    if (Result.isError(discarded)) {
      return Result.err(
        new PublisherRequestAbortedError({
          message: "Publisher request was aborted while discarding a redirect",
          url: state.url.href,
          origin: state.url.origin,
          cause: discarded.error.cause,
        }),
      );
    }
    if (redirects >= MAX_REDIRECTS) {
      return redirectLimitResult(state);
    }
    if (!URL.canParse(location, state.url.href)) {
      return Result.err(
        new PublisherTargetRefusedError({
          message: "publisher redirect location is invalid",
          url: state.url.href,
          origin: state.url.origin,
          cause: location,
        }),
      );
    }
    const nextUrl = new URL(location, state.url);
    const redirected = redirectedRequestInit({
      response,
      currentUrl: state.url,
      nextUrl,
      requestInit: state.requestInit,
      headers,
    });
    if (Result.isError(redirected)) {
      return redirected;
    }
    state.requestInit = redirected.value;
    state.url = nextUrl;
  }
};

export const createPolitePublisherFetch = <Target extends PublisherTarget>({
  validateTarget,
  fetcher,
  clock = {
    now: () => performance.now(),
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      await raceAbort(Bun.sleep(ms), signal);
      signal?.throwIfAborted();
    },
  },
  robotsTtlMs = ROBOTS_TTL_MS,
  robotsRetryMs = ROBOTS_RETRY_MS,
  robotsLoadTimeoutMs = ROBOTS_LOAD_TIMEOUT_MS,
  defaultMinimumIntervalMs = DEFAULT_MINIMUM_INTERVAL_MS,
  onTelemetry,
}: PublisherFetcherOptions<Target>) => {
  const robotsFor = createRobotsCache({
    fetcher,
    validateTarget,
    now: clock.now,
    robotsTtlMs,
    robotsRetryMs,
    robotsLoadTimeoutMs,
  });
  const reserve = createOriginScheduler(clock);
  const runtime: PublisherRuntime<Target> = {
    fetcher,
    validateTarget,
    robotsFor,
    reserve,
    defaultMinimumIntervalMs,
    onTelemetry: onTelemetry
      ? async (event) => await onTelemetry(event)
      : undefined,
  };
  return async (input: string | URL, options: PublisherFetchOptions = {}) =>
    await walkPublisherRedirects(
      input,
      options,
      bindPublisherRuntimeToAbort(runtime, options.init?.signal ?? undefined),
    );
};
