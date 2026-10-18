import { Result, TaggedError } from "better-result";

import type { Fetcher } from "./index";

const ROBOTS_MAX_BYTES = 512 * 1024;
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const ROBOTS_RETRY_MS = 60 * 1000;
const DEFAULT_MINIMUM_INTERVAL_MS = 1000;
const MAX_REDIRECTS = 5;
const PRODUCT_TOKEN = "Stella";

export type PublisherPolicy =
  | { type: "obey" }
  | { type: "licensed"; basis: string; evidenceUrl: string };
export type PublisherEnforcement = "enforce" | "audit";
export type PublisherRobotsDecision =
  | "allowed"
  | "allow_all_4xx"
  | "robots_disallowed"
  | "agent_excluded"
  | "robots_unavailable"
  | "licensed_bypass"
  | "audit_bypass";

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
export class PublisherRedirectLimitError extends TaggedError(
  "publisher_redirect_limit",
)<RefusalFields> {}
export class PublisherTargetRefusedError extends TaggedError(
  "publisher_target_refused",
)<RefusalFields & { cause: unknown }> {}
export class PublisherBodyNotReplayableError extends TaggedError(
  "publisher_body_not_replayable",
)<RefusalFields> {}
export type PublisherPolicyError =
  | RobotsDisallowedError
  | AgentExcludedError
  | RobotsUnavailableError
  | PublisherRedirectLimitError
  | PublisherTargetRefusedError
  | PublisherBodyNotReplayableError;

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
  enforcement: PublisherEnforcement;
  policy: PublisherPolicy;
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
  onTelemetry?: (event: PublisherTelemetry) => void;
};
type PublisherFetchOptions = {
  init?: Omit<RequestInit, "redirect">;
  userAgent: string;
  policy?: PublisherPolicy;
  enforcement: PublisherEnforcement;
};

type Rule = { type: "allow" | "disallow"; pattern: string };
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

const normalizeOctets = (value: string) =>
  value.replaceAll(/%[\da-f]{2}/giu, (encoded) => {
    const octet = Number.parseInt(encoded.slice(1), 16);
    const character = String.fromCodePoint(octet);
    return /^[A-Za-z0-9._~-]$/u.test(character)
      ? character
      : `%${encoded.slice(1).toUpperCase()}`;
  });

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
        current.rules.push({ type: field, pattern: value });
      }
      continue;
    }
    if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
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

const ruleExpression = (pattern: string) => {
  const normalized = normalizeOctets(pattern);
  const anchored = normalized.endsWith("$");
  const source = (anchored ? normalized.slice(0, -1) : normalized)
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`, "u");
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
    .filter(({ pattern }) => ruleExpression(pattern).test(normalizedPath))
    .map((rule) => ({
      ...rule,
      specificity: normalizeOctets(rule.pattern)
        .replaceAll("*", "")
        .replace(/\$$/u, "").length,
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

const readBoundedText = async (response: Response) => {
  if (!response.body) {
    return Result.ok("");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > ROBOTS_MAX_BYTES) {
        exceeded = true;
        break;
      }
      chunks.push(next.value);
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  if (exceeded) {
    return Result.err(
      new RobotsUnavailableError({
        message: "robots.txt exceeds the byte limit",
        url: response.url || "robots.txt",
        origin: response.url ? new URL(response.url).origin : "unknown",
      }),
    );
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Result.ok(new TextDecoder().decode(bytes));
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
  requestInit: Omit<RequestInit, "redirect"> | undefined;
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

type LoadRobotsOptions = {
  fetcher: Fetcher;
  validateTarget: PublisherFetcherOptions["validateTarget"];
  origin: string;
  now: () => number;
  robotsTtlMs: number;
  robotsRetryMs: number;
};

const loadRobots = async ({
  fetcher,
  validateTarget,
  origin,
  now,
  robotsTtlMs,
  robotsRetryMs,
}: LoadRobotsOptions): Promise<CachedRobots> => {
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
        headers: { "User-Agent": PRODUCT_TOKEN },
        redirect: "manual",
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
    const cancelled = await Result.tryPromise(async () =>
      fetched.value.body?.cancel(),
    );
    if (Result.isError(cancelled)) {
      failure = cancelled.error.cause;
      break;
    }
    target = new URL(location, requestTarget);
  }
  if (!finalResponse) {
    return {
      state: { type: "unavailable", cause: failure },
      expiresAt: now() + robotsRetryMs,
    };
  }
  if (finalResponse.status >= 400 && finalResponse.status < 500) {
    return { state: { type: "allow-all" }, expiresAt: now() + robotsTtlMs };
  }
  if (finalResponse.status >= 500) {
    return {
      state: { type: "unavailable" },
      expiresAt: now() + robotsRetryMs,
    };
  }
  const body = await Result.tryPromise(async () =>
    readBoundedText(finalResponse),
  );
  if (Result.isError(body)) {
    return {
      state: {
        type: "unavailable",
        cause: body.error.cause,
      },
      expiresAt: now() + robotsRetryMs,
    };
  }
  if (Result.isError(body.value)) {
    return {
      state: { type: "unavailable", cause: body.value.error },
      expiresAt: now() + robotsRetryMs,
    };
  }
  return {
    state: { type: "rules", groups: parseRobots(body.value.value) },
    expiresAt: now() + robotsTtlMs,
  };
};

export const createPolitePublisherFetch = ({
  validateTarget,
  fetcher = globalThis.fetch,
  clock = {
    now: () => performance.now(),
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      await Bun.sleep(ms);
      signal?.throwIfAborted();
    },
  },
  robotsTtlMs = ROBOTS_TTL_MS,
  robotsRetryMs = ROBOTS_RETRY_MS,
  defaultMinimumIntervalMs = DEFAULT_MINIMUM_INTERVAL_MS,
  onTelemetry = () => undefined,
}: PublisherFetcherOptions) => {
  const robotsCache = new Map<string, CachedRobots>();
  const robotsLoads = new Map<string, Promise<CachedRobots>>();
  const originQueues = new Map<string, Promise<void>>();
  const nextAllowedAt = new Map<string, number>();

  const robotsFor = async (origin: string) => {
    const cached = robotsCache.get(origin);
    if (cached && cached.expiresAt > clock.now()) {
      return cached.state;
    }
    const activeLoad = robotsLoads.get(origin);
    if (activeLoad) {
      return (await activeLoad).state;
    }
    const pending = loadRobots({
      fetcher,
      validateTarget,
      origin,
      now: clock.now,
      robotsTtlMs,
      robotsRetryMs,
    });
    robotsLoads.set(origin, pending);
    const loaded = await pending;
    robotsLoads.delete(origin);
    robotsCache.set(origin, loaded);
    return loaded.state;
  };

  const reserve = async (
    origin: string,
    intervalMs: number,
    signal?: AbortSignal,
  ) => {
    const previous = originQueues.get(origin) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    originQueues.set(
      origin,
      previous.then(async () => current),
    );
    await previous;
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

  return async (
    input: string | URL,
    {
      init,
      userAgent,
      policy = { type: "obey" },
      enforcement,
    }: PublisherFetchOptions,
  ): Promise<Result<PublisherFetchResult, PublisherPolicyError>> => {
    let url = new URL(input);
    let requestInit = init;
    let decision: PublisherRobotsDecision = "allowed";
    let delayAppliedMs = 0;
    for (let redirects = 0; ; redirects += 1) {
      const validated = await validatePublisherTarget(url, validateTarget);
      if (Result.isError(validated)) {
        return validated;
      }
      url = validated.value;
      const state = await robotsFor(url.origin);
      if (
        state.type === "unavailable" &&
        PublisherTargetRefusedError.is(state.cause)
      ) {
        return Result.err(state.cause);
      }
      const {
        refusal,
        intervalMs,
        decision: robotsDecision,
      } = publisherPolicyFor(state, url, defaultMinimumIntervalMs);
      decision = robotsDecision ?? decision;
      if (refusal && policy.type === "obey" && enforcement === "enforce") {
        return Result.err(refusal);
      }
      if (refusal) {
        onTelemetry({
          event: "publisher_fetch_policy_bypass",
          url: url.href,
          origin: url.origin,
          refusal,
          enforcement,
          policy,
        });
        decision =
          policy.type === "licensed" ? "licensed_bypass" : "audit_bypass";
      }
      delayAppliedMs += await reserve(
        url.origin,
        intervalMs,
        requestInit?.signal ?? undefined,
      );
      const headers = new Headers(requestInit?.headers);
      headers.set("User-Agent", userAgent);
      const response = await fetcher(url, {
        ...requestInit,
        headers,
        redirect: "manual",
      });
      if (!isRedirect(response)) {
        return Result.ok({
          response,
          robotsDecision: decision,
          delayAppliedMs,
        });
      }
      const location = response.headers.get("location");
      if (!location) {
        return Result.ok({
          response,
          robotsDecision: decision,
          delayAppliedMs,
        });
      }
      if (redirects >= MAX_REDIRECTS) {
        const redirectRefusal = new PublisherRedirectLimitError({
          message: "publisher response exceeded the redirect limit",
          url: url.href,
          origin: url.origin,
        });
        if (policy.type === "obey" && enforcement === "enforce") {
          return Result.err(redirectRefusal);
        }
        onTelemetry({
          event: "publisher_fetch_policy_bypass",
          url: url.href,
          origin: url.origin,
          refusal: redirectRefusal,
          enforcement,
          policy,
        });
        return Result.ok({
          response,
          robotsDecision:
            policy.type === "licensed" ? "licensed_bypass" : "audit_bypass",
          delayAppliedMs,
        });
      }
      await response.body?.cancel();
      const nextUrl = new URL(location, url);
      const redirected = redirectedRequestInit({
        response,
        currentUrl: url,
        nextUrl,
        requestInit,
        headers,
      });
      if (Result.isError(redirected)) {
        return redirected;
      }
      requestInit = redirected.value;
      url = nextUrl;
    }
  };
};
