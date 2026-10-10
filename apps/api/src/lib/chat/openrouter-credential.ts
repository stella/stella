import { GetWebIdentityTokenCommand, STSClient } from "@aws-sdk/client-sts";
import { Result } from "better-result";
import * as v from "valibot";

import { backoffDelay } from "@stll/concurrency/backoff-delay";
import { fetchWithTimeout } from "@stll/fetch";
import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import { managedProviderUnavailable } from "@/api/lib/chat/provider-data-policy";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import {
  emitManagedCredentialUnavailable,
  emitOpenRouterTokenExchange,
} from "@/api/lib/observability/request-metrics";
import { withTimeout } from "@/api/lib/with-timeout";

const REQUEST_TIMEOUT_MS = 5000;
const TOKEN_LIFETIME_SECONDS = 900;
const MINIMUM_REMAINING_MS = 600_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5000;
const MAX_RETRY_COOLDOWN_MS = 60_000;
const EXCHANGE_URL = "https://openrouter.ai/api/v1/oauth/token";

export type ManagedOpenRouterConfiguration =
  | { type: "static"; apiKey: string }
  | { type: "federated"; policyId: string; audience: string; region: string }
  | { type: "unavailable" };

export type ManagedOpenRouterCredential =
  | { type: "static"; apiKey: string }
  | { type: "federated"; apiKey: string; invalidate: () => void };

export const getManagedOpenRouterConfiguration =
  (): ManagedOpenRouterConfiguration => {
    if (env.OPENROUTER_API_KEY?.trim()) {
      return { type: "static", apiKey: env.OPENROUTER_API_KEY };
    }
    if (
      env.OPENROUTER_WIF_POLICY_ID &&
      env.OPENROUTER_WIF_AUDIENCE &&
      env.OPENROUTER_WIF_STS_REGION
    ) {
      return {
        type: "federated",
        policyId: env.OPENROUTER_WIF_POLICY_ID,
        audience: env.OPENROUTER_WIF_AUDIENCE,
        region: env.OPENROUTER_WIF_STS_REGION,
      };
    }
    return { type: "unavailable" };
  };

const exchangeSchema = v.object({
  access_token: v.pipe(
    v.string(),
    v.nonEmpty(),
    v.maxLength(16_384),
    v.regex(/^\S+$/u),
  ),
  token_type: v.literal("Bearer"),
  expires_in: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(TOKEN_LIFETIME_SECONDS),
  ),
});

type TokenEntry = {
  apiKey: string;
  configurationKey: string;
  expiresAt: number;
  expiresMonotonic: number;
};

type CredentialProviderOptions = {
  configuration: () => ManagedOpenRouterConfiguration;
  createStsClient?: (region: string) => STSClient;
  fetchExchange?: typeof fetchWithTimeout;
  now?: () => number;
  monotonicNow?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
};

const retryAfterMs = (
  value: string | null,
  now: number,
): number | undefined => {
  if (value === null || value.length > 128) {
    return undefined;
  }
  if (/^\d+$/u.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay)
      ? Math.min(delay, MAX_RETRY_COOLDOWN_MS)
      : undefined;
  }
  const match =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/u.exec(
      value,
    );
  if (!match) {
    return undefined;
  }
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const parsed = Result.try(() =>
    Temporal.ZonedDateTime.from(
      {
        timeZone: "UTC",
        year: Number(match[3]),
        month: months.indexOf(match[2] ?? "") + 1,
        day: Number(match[1]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6]),
      },
      { overflow: "reject" },
    ),
  );
  return Result.isOk(parsed)
    ? Math.min(
        MAX_RETRY_COOLDOWN_MS,
        Math.max(0, parsed.value.epochMilliseconds - now),
      )
    : undefined;
};

class ManagedOpenRouterCredentialProvider {
  private readonly options;
  constructor({
    configuration,
    createStsClient = (region) => new STSClient({ region, maxAttempts: 1 }),
    fetchExchange = fetchWithTimeout,
    now = () => Temporal.Now.instant().epochMilliseconds,
    monotonicNow = () => performance.now(),
    sleep = Bun.sleep,
    random = Math.random,
    timeoutMs = REQUEST_TIMEOUT_MS,
  }: CredentialProviderOptions) {
    this.options = {
      configuration,
      createStsClient,
      fetchExchange,
      now,
      monotonicNow,
      sleep,
      random,
      timeoutMs,
    };
  }
  private cache: TokenEntry | undefined;
  private flight:
    | {
        configurationKey: string;
        generation: number;
        promise: Promise<Result<string, HandlerError<503>>>;
      }
    | undefined;
  private activeConfigurationKey: string | undefined;
  private generation = 0;
  private lastWall = -Infinity;
  private lastMonotonic = -Infinity;
  private retryNotBefore = 0;
  private loggedMode: ManagedOpenRouterConfiguration["type"] | undefined;

  private readonly clock = () => {
    const { now, monotonicNow } = this.options;
    const wall = now();
    const monotonic = monotonicNow();
    if (
      !Number.isFinite(wall) ||
      !Number.isFinite(monotonic) ||
      wall < this.lastWall ||
      monotonic < this.lastMonotonic
    ) {
      return undefined;
    }
    this.lastWall = wall;
    this.lastMonotonic = monotonic;
    return { wall, monotonic };
  };
  private readonly unavailable = () =>
    Result.err(managedProviderUnavailable("openrouter"));

  private readonly mint = async (
    config: Extract<ManagedOpenRouterConfiguration, { type: "federated" }>,
    configurationKey: string,
    currentGeneration: number,
  ): Promise<Result<string, HandlerError<503>>> => {
    const { fetchExchange, timeoutMs, sleep, random } = this.options;
    const identity = await this.mintIdentity(config);
    if (Result.isError(identity)) {
      return identity;
    }
    const { subjectToken, sourceExpiration } = identity.value;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const started = this.clock();
      if (!started || currentGeneration !== this.generation) {
        return this.unavailable();
      }
      const exchanged = await Result.tryPromise({
        try: async () =>
          await withTimeout(
            async (signal) => {
              const response = await fetchExchange(EXCHANGE_URL, {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                  grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                  subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
                  subject_token: subjectToken,
                  federation_policy_id: config.policyId,
                  scope: "inference",
                }),
                timeoutMs,
                signal,
                redirect: "error",
              });
              // Parse successful bodies only; failure bodies can carry credentials.
              const body: unknown = response.ok
                ? await response.json()
                : undefined;
              return { response, body };
            },
            { label: "Managed credential exchange", timeoutMs },
          ),
        catch: (error) => error,
      });
      let delay: number | undefined;
      if (Result.isError(exchanged)) {
        emitOpenRouterTokenExchange(
          TimeoutError.is(exchanged.error) ||
            (exchanged.error instanceof Error &&
              exchanged.error.name === "TimeoutError")
            ? "timeout"
            : "exchange_5xx",
          config.policyId,
        );
        delay = undefined;
      } else {
        const { response, body } = exchanged.value;
        if (response.ok) {
          const parsed = v.safeParse(exchangeSchema, body);
          const finished = this.clock();
          if (
            !parsed.success ||
            !finished ||
            currentGeneration !== this.generation
          ) {
            emitOpenRouterTokenExchange("exchange_5xx", config.policyId);
            return this.unavailable();
          }
          const lifetime = Math.min(
            parsed.output.expires_in * 1000,
            sourceExpiration - started.wall,
          );
          const entry = {
            apiKey: parsed.output.access_token,
            configurationKey,
            expiresAt: started.wall + lifetime,
            expiresMonotonic: started.monotonic + lifetime,
          };
          emitOpenRouterTokenExchange("ok", config.policyId);
          if (
            Math.min(
              entry.expiresAt - finished.wall,
              entry.expiresMonotonic - finished.monotonic,
            ) < MINIMUM_REMAINING_MS
          ) {
            return this.unavailable();
          }
          this.cache = entry;
          return Result.ok(entry.apiKey);
        }
        if (response.status === 429) {
          emitOpenRouterTokenExchange("exchange_429", config.policyId);
          const received = this.clock();
          if (!received) {
            return this.unavailable();
          }
          delay = retryAfterMs(
            response.headers.get("retry-after"),
            received.wall,
          );
          if (delay !== undefined) {
            this.retryNotBefore = received.monotonic + delay;
          }
        } else if (response.status === 503) {
          emitOpenRouterTokenExchange("exchange_5xx", config.policyId);
        } else {
          emitOpenRouterTokenExchange(
            response.status >= 500 ? "exchange_5xx" : "exchange_4xx",
            config.policyId,
          );
          return this.unavailable();
        }
      }
      const backoff = backoffDelay(attempt, {
        baseMs: 250,
        jitter: {
          type: "multiplicative",
          random: random(),
          minFactor: 0.5,
          maxFactor: 1.5,
        },
      });
      const wait = Math.max(delay ?? 0, backoff);
      if (attempt === MAX_ATTEMPTS - 1 || wait > MAX_RETRY_DELAY_MS) {
        return this.unavailable();
      }
      await sleep(wait);
    }
    return this.unavailable();
  };

  get = async (): Promise<Result<string, HandlerError<503>>> => {
    const { configuration } = this.options;
    const config = configuration();
    if (this.loggedMode !== config.type) {
      logger.info(
        "ai.managed_credential.mode",
        config.type === "federated"
          ? { mode: config.type, federation_policy_id: config.policyId }
          : { mode: config.type },
      );
      this.loggedMode = config.type;
    }
    if (config.type === "static") {
      if (this.activeConfigurationKey !== undefined) {
        this.generation++;
        this.activeConfigurationKey = undefined;
        this.cache = undefined;
        this.flight = undefined;
        this.retryNotBefore = 0;
      }
      return Result.ok(config.apiKey);
    }
    if (config.type === "unavailable") {
      emitManagedCredentialUnavailable();
      return this.unavailable();
    }
    const current = this.clock();
    const configurationKey = JSON.stringify([
      config.policyId,
      config.audience,
      config.region,
    ]);
    if (this.activeConfigurationKey !== configurationKey) {
      this.generation++;
      this.activeConfigurationKey = configurationKey;
      this.cache = undefined;
      this.flight = undefined;
      this.retryNotBefore = 0;
    }
    if (!current || current.monotonic < this.retryNotBefore) {
      emitManagedCredentialUnavailable();
      return this.unavailable();
    }
    // Ten minutes at handout is stricter than the five-minute refresh margin:
    // a fifteen-minute token is reused for at most five minutes, then reminted.
    if (
      this.cache?.configurationKey === configurationKey &&
      Math.min(
        this.cache.expiresAt - current.wall,
        this.cache.expiresMonotonic - current.monotonic,
      ) >= MINIMUM_REMAINING_MS
    ) {
      return Result.ok(this.cache.apiKey);
    }
    if (
      this.flight?.configurationKey !== configurationKey ||
      this.flight.generation !== this.generation
    ) {
      const currentGeneration = this.generation;
      const promise = Result.tryPromise({
        try: async () =>
          await this.mint(config, configurationKey, currentGeneration),
        catch: () => managedProviderUnavailable("openrouter"),
      }).then((result) => Result.flatten(result));
      this.flight = {
        configurationKey,
        generation: currentGeneration,
        promise,
      };
    }
    const pending = this.flight;
    const result = await pending.promise;
    if (this.flight === pending) {
      this.flight = undefined;
    }
    const handedOut = this.clock();
    if (
      Result.isError(result) ||
      !handedOut ||
      pending.generation !== this.generation ||
      this.cache?.configurationKey !== configurationKey ||
      this.cache.apiKey !== result.value ||
      Math.min(
        this.cache.expiresAt - handedOut.wall,
        this.cache.expiresMonotonic - handedOut.monotonic,
      ) < MINIMUM_REMAINING_MS
    ) {
      emitManagedCredentialUnavailable();
      return this.unavailable();
    }
    return result;
  };

  invalidate = (apiKey: string) => {
    if (this.cache?.apiKey === apiKey) {
      this.cache = undefined;
      this.generation++;
    }
  };
  private readonly mintIdentity = async (
    config: Extract<ManagedOpenRouterConfiguration, { type: "federated" }>,
  ) => {
    const { createStsClient, timeoutMs } = this.options;
    let identity;
    for (let attempt = 0; attempt < 2; attempt++) {
      const created = Result.try(() => createStsClient(config.region));
      if (Result.isError(created)) {
        emitOpenRouterTokenExchange("sts_error", config.policyId);
        return this.unavailable();
      }
      const client = created.value;
      const minted = await Result.tryPromise({
        try: async () =>
          await withTimeout(
            async (signal) =>
              await client.send(
                new GetWebIdentityTokenCommand({
                  Audience: [config.audience],
                  DurationSeconds: TOKEN_LIFETIME_SECONDS,
                  // https://docs.aws.amazon.com/STS/latest/APIReference/API_GetWebIdentityToken.html
                  SigningAlgorithm: "RS256",
                }),
                { abortSignal: signal },
              ),
            { label: "Managed identity mint", timeoutMs },
          ),
        catch: (error) => error,
      });
      const closed = Result.try(() => client.destroy());
      if (Result.isError(closed)) {
        emitOpenRouterTokenExchange("sts_error", config.policyId);
        return this.unavailable();
      }
      if (Result.isOk(minted)) {
        identity = minted.value;
        break;
      }
      emitOpenRouterTokenExchange(
        TimeoutError.is(minted.error) ? "timeout" : "sts_error",
        config.policyId,
      );
      if (
        attempt === 0 &&
        minted.error instanceof Error &&
        minted.error.name === "SessionDurationEscalationException"
      ) {
        continue;
      }
      return this.unavailable();
    }
    if (
      !identity?.WebIdentityToken ||
      !identity.Expiration ||
      !Number.isFinite(identity.Expiration.getTime())
    ) {
      emitOpenRouterTokenExchange("sts_error", config.policyId);
      return this.unavailable();
    }
    return Result.ok({
      subjectToken: identity.WebIdentityToken,
      sourceExpiration: identity.Expiration.getTime(),
    });
  };
}

export const createManagedOpenRouterCredentialProvider = (
  options: CredentialProviderOptions,
) => new ManagedOpenRouterCredentialProvider(options);

let provider:
  | ReturnType<typeof createManagedOpenRouterCredentialProvider>
  | undefined;
export const getManagedOpenRouterCredentialProvider = () =>
  (provider ??= createManagedOpenRouterCredentialProvider({
    configuration: getManagedOpenRouterConfiguration,
  }));

export const getManagedOpenRouterCredential = async (): Promise<
  Result<ManagedOpenRouterCredential, HandlerError<503>>
> => {
  const credentialProvider = getManagedOpenRouterCredentialProvider();
  const configuration = getManagedOpenRouterConfiguration();
  const result = await credentialProvider.get();
  return result.map((apiKey) =>
    configuration.type === "federated"
      ? {
          type: "federated" as const,
          apiKey,
          invalidate: () => credentialProvider.invalidate(apiKey),
        }
      : { type: "static" as const, apiKey },
  );
};
