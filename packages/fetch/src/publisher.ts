import { Result, TaggedError } from "better-result";

import type { Fetcher, TransportRequestInit } from "./index";

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
  | { type: "obey" }
  | { type: "licensed"; basis: string; evidenceUrl: string };
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
export type PublisherPolicyError =
  | RobotsDisallowedError
  | AgentExcludedError
  | RobotsUnavailableError
  | CrawlDelayUnsupportedError
  | PublisherRedirectLimitError
  | PublisherTargetRefusedError
  | PublisherBodyNotReplayableError
  | PublisherRequestAbortedError;

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
type PublisherFetcherOptions = {
  validateTarget: (url: URL) => Promise<Result<URL, unknown>>;
  fetcher?: Fetcher;
  clock?: Clock;
  robotsTtlMs?: number;
  robotsRetryMs?: number;
  defaultMinimumIntervalMs?: number;
  robotsLoadTimeoutMs?: number;
  onTelemetry?: (event: PublisherTelemetry) => void;
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

const publisherPolicyFor = (
  state: RobotsState,
  url: URL,
  defaultMinimumIntervalMs: number,
): {
  decision?: PublisherRobotsDecision;
  intervalMs: number;
  refusal?: PublisherPolicyError;
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
  for (const rawLine of body.split(/\r?\n/u)) {
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

const selectedGroups = (groups: Group[], productToken: string) => {
  const token = productToken.toLowerCase();
  const agentScore = (agent: string) => {
    if (agent === "*") {
      return 0;
    }
    return token.startsWith(agent) ? agent.length : -1;
  };
  const scored = groups.map((group) => ({
    group,
    score: Math.max(...group.agents.map(agentScore)),
  }));
  const best = Math.max(-1, ...scored.map(({ score }) => score));
  return scored
    .filter(({ score }) => score === best && score >= 0)
    .map(({ group }) => group);
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
    specificity: body.replaceAll("*", "").length,
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

const abortPromise = async (signal: AbortSignal) =>
  await new Promise<never>((_resolve, reject) => {
    const reason = () =>
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    if (signal.aborted) {
      reject(reason());
      return;
    }
    signal.addEventListener("abort", () => reject(reason()), {
      once: true,
    });
  });

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
  // oxlint-disable-next-line require-stream-reader-disposal/require-stream-reader-disposal -- the finally block below cancels with the same overall deadline before releasing
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await Promise.race([reader.read(), abortPromise(signal)]);
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
      await Promise.race([reader.cancel(), abortPromise(signal)]);
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

const isRedirect = (response: Response) =>
  response.status >= 300 && response.status < 400;

const validatePublisherTarget = async (
  url: URL,
  validateTarget: PublisherFetcherOptions["validateTarget"],
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
  if (
    !dropBody &&
    (response.status === 307 || response.status === 308) &&
    requestInit?.body instanceof ReadableStream
  ) {
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
const discardBody = async (response: Response, deadline: AbortSignal) =>
  Result.tryPromise(async () =>
    Promise.race([response.body?.cancel(), abortPromise(deadline)]),
  );

type LoadRobotsOptions = {
  fetcher: Fetcher;
  validateTarget: PublisherFetcherOptions["validateTarget"];
  origin: string;
  now: () => number;
  robotsTtlMs: number;
  robotsRetryMs: number;
  robotsLoadTimeoutMs: number;
};

const loadRobots = async ({
  fetcher,
  validateTarget,
  origin,
  now,
  robotsTtlMs,
  robotsRetryMs,
  robotsLoadTimeoutMs,
}: LoadRobotsOptions): Promise<
  | { type: "cacheable"; robots: CachedRobots }
  | { type: "refused"; state: RobotsState }
> => {
  const deadline = AbortSignal.timeout(robotsLoadTimeoutMs);
  let target = new URL("/robots.txt", origin);
  let finalResponse: Response | undefined;
  let failure: unknown;
  for (let redirects = 0; ; redirects += 1) {
    const requestTarget = target;
    const validated = await validatePublisherTarget(
      requestTarget,
      validateTarget,
    );
    if (Result.isError(validated)) {
      failure = validated.error;
      break;
    }
    const fetched = await Result.tryPromise(async () =>
      fetcher(validated.value, {
        headers: { "User-Agent": PUBLISHER_USER_AGENT },
        redirect: "manual",
        signal: deadline,
      }),
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

type RobotsCacheOptions = Pick<
  LoadRobotsOptions,
  | "fetcher"
  | "validateTarget"
  | "robotsTtlMs"
  | "robotsRetryMs"
  | "robotsLoadTimeoutMs"
> & { now: () => number };

const createRobotsCache = (options: RobotsCacheOptions) => {
  const settled = new Map<string, CachedRobots>();
  const pending = new Map<string, ReturnType<typeof loadRobots>>();
  return async (origin: string) => {
    const cached = settled.get(origin);
    if (cached && cached.expiresAt > options.now()) {
      return cached.state;
    }
    const robotsTarget = await validatePublisherTarget(
      new URL("/robots.txt", origin),
      options.validateTarget,
    );
    if (Result.isError(robotsTarget)) {
      return { type: "unavailable", cause: robotsTarget.error } as const;
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
      signal ? Promise.race([previous, abortPromise(signal)]) : previous,
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
        await clock.sleep(delay, signal);
      }
      nextAllowedAt.set(origin, clock.now() + intervalMs);
      return delay;
    } finally {
      release();
    }
  };
};

type PublisherRuntime = {
  fetcher: Fetcher;
  validateTarget: PublisherFetcherOptions["validateTarget"];
  robotsFor: (origin: string) => Promise<RobotsState>;
  reserve: (
    origin: string,
    intervalMs: number,
    signal?: AbortSignal,
  ) => Promise<number>;
  defaultMinimumIntervalMs: number;
  onTelemetry: (event: PublisherTelemetry) => void;
};

type WalkState = {
  // A licensed policy authorizes only the origin the caller requested.
  requestedOrigin: string;
  url: URL;
  requestInit: PublisherFetchOptions["init"];
  decision: PublisherRobotsDecision;
  delayAppliedMs: number;
};

const enforcePublisherPolicy = async (
  state: WalkState,
  options: PublisherFetchOptions,
  runtime: PublisherRuntime,
) => {
  const robots = await runtime.robotsFor(state.url.origin);
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
  const policy =
    state.url.origin === state.requestedOrigin ? options.policy : undefined;
  if (evaluated.refusal && policy?.type !== "licensed") {
    return Result.err(evaluated.refusal);
  }
  if (evaluated.refusal) {
    runtime.onTelemetry({
      event: "publisher_fetch_policy_bypass",
      url: state.url.href,
      origin: state.url.origin,
      refusal: evaluated.refusal,
      policy,
      delayMs: Math.min(evaluated.intervalMs, MAX_CRAWL_DELAY_MS),
    });
    state.decision = "licensed_bypass";
  }
  return Result.ok(Math.min(evaluated.intervalMs, MAX_CRAWL_DELAY_MS));
};

const redirectLimitResult = (state: WalkState) => {
  const refusal = new PublisherRedirectLimitError({
    message: "publisher response exceeded the redirect limit",
    url: state.url.href,
    origin: state.url.origin,
  });
  return Result.err(refusal);
};

const walkPublisherRedirects = async (
  input: string | URL,
  options: PublisherFetchOptions,
  runtime: PublisherRuntime,
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
    const validated = await validatePublisherTarget(
      state.url,
      runtime.validateTarget,
    );
    if (Result.isError(validated)) {
      return validated;
    }
    state.url = validated.value;
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
    const response = await runtime.fetcher(state.url, {
      ...state.requestInit,
      headers,
      redirect: "manual",
    });
    const location = response.headers.get("location");
    if (!isRedirect(response) || !location) {
      return Result.ok({
        response,
        robotsDecision: state.decision,
        delayAppliedMs: state.delayAppliedMs,
      });
    }
    await response.body?.cancel();
    if (redirects >= MAX_REDIRECTS) {
      return redirectLimitResult(state);
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

export const createPolitePublisherFetch = ({
  validateTarget,
  fetcher = globalThis.fetch,
  clock = {
    now: () => performance.now(),
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      await (signal
        ? Promise.race([Bun.sleep(ms), abortPromise(signal)])
        : Bun.sleep(ms));
      signal?.throwIfAborted();
    },
  },
  robotsTtlMs = ROBOTS_TTL_MS,
  robotsRetryMs = ROBOTS_RETRY_MS,
  robotsLoadTimeoutMs = ROBOTS_LOAD_TIMEOUT_MS,
  defaultMinimumIntervalMs = DEFAULT_MINIMUM_INTERVAL_MS,
  onTelemetry = () => undefined,
}: PublisherFetcherOptions) => {
  const robotsFor = createRobotsCache({
    fetcher,
    validateTarget,
    now: clock.now,
    robotsTtlMs,
    robotsRetryMs,
    robotsLoadTimeoutMs,
  });
  const reserve = createOriginScheduler(clock);
  return async (input: string | URL, options: PublisherFetchOptions = {}) =>
    await walkPublisherRedirects(input, options, {
      fetcher,
      validateTarget,
      robotsFor,
      reserve,
      defaultMinimumIntervalMs,
      onTelemetry,
    });
};
