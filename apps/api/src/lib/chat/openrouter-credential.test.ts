import { STSClient } from "@aws-sdk/client-sts";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { env } from "@/api/env";
import {
  getManagedOpenRouterConfiguration,
  createManagedOpenRouterCredentialProvider,
} from "@/api/lib/chat/openrouter-credential";
import { MANAGED_PROVIDER_UNAVAILABLE_CODE } from "@/api/lib/chat/provider-data-policy";
import {
  setMetricLineSinkForTesting,
  resetMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

const POLICY_ID = "fixture-policy";
const AUDIENCE = "https://openrouter.ai";
const REGION = "eu-west-1";
const JWT = "fake.sts.jwt";
const ACCESS_TOKEN = "fake-openrouter-access-token";
const START = Date.parse("2028-04-05T12:00:00.000Z");

type ProviderOptions = Parameters<
  typeof createManagedOpenRouterCredentialProvider
>[0];
type FetchExchange = NonNullable<ProviderOptions["fetchExchange"]>;
type StsRequestHandler = STSClient["config"]["requestHandler"];
type StsHttpRequest = Parameters<StsRequestHandler["handle"]>[0];
type StsHttpResponse = Awaited<
  ReturnType<StsRequestHandler["handle"]>
>["response"];

type StsReply = { status: number; body: string } | Error;
type ExchangeReply = Response | Error | (() => Promise<Response>);

const successExchange = (accessToken = ACCESS_TOKEN, expiresIn = 900) =>
  Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
  });

const stsSuccess = (expiration: Date, token = JWT): StsReply => ({
  status: 200,
  body: `<GetWebIdentityTokenResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetWebIdentityTokenResult><WebIdentityToken>${token}</WebIdentityToken><Expiration>${expiration.toISOString()}</Expiration></GetWebIdentityTokenResult><ResponseMetadata><RequestId>fixture-request</RequestId></ResponseMetadata></GetWebIdentityTokenResponse>`,
});

const stsFailure = (code: string): StsReply => ({
  status: 400,
  body: `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>${code}</Code><Message>fixture failure</Message></Error><RequestId>fixture-request</RequestId></ErrorResponse>`,
});

const requestBodyText = (body: StsHttpRequest["body"]): string => {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  return "";
};

const managedUnavailable = (
  result: Awaited<
    ReturnType<
      ReturnType<typeof createManagedOpenRouterCredentialProvider>["get"]
    >
  >,
) => {
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toMatchObject({
      status: 503,
      code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
    });
  }
};

const createClock = (wall = START) => {
  let wallNow = wall;
  let monotonic = 0;
  return {
    now: () => wallNow,
    monotonicNow: () => monotonic,
    advance: (milliseconds: number) => {
      wallNow += milliseconds;
      monotonic += milliseconds;
    },
    setWall: (value: number) => {
      wallNow = value;
    },
    setMonotonic: (value: number) => {
      monotonic = value;
    },
  };
};

const federatedConfiguration = {
  type: "federated",
  policyId: POLICY_ID,
  audience: AUDIENCE,
  region: REGION,
} as const;

const createHarness = ({
  configuration = () => federatedConfiguration,
  clock = createClock(),
  expirationMs = 900_000,
  stsReplies = [],
  exchangeReplies = [],
  exchangeFetcher,
  random = () => 0,
  timeoutMs = 100,
}: {
  configuration?: ProviderOptions["configuration"];
  clock?: ReturnType<typeof createClock>;
  expirationMs?: number;
  stsReplies?: StsReply[];
  exchangeReplies?: ExchangeReply[];
  exchangeFetcher?: FetchExchange;
  random?: () => number;
  timeoutMs?: number;
} = {}) => {
  const stsRequests: {
    region: string;
    request: StsHttpRequest;
    body: string;
  }[] = [];
  const exchangeRequests: { url: string; body: string; init: RequestInit }[] =
    [];
  const sleeps: number[] = [];
  let stsClients = 0;
  let destroyedStsClients = 0;
  let exchangeCalls = 0;

  const createStsClient: NonNullable<ProviderOptions["createStsClient"]> = (
    region,
  ) => {
    stsClients += 1;
    const handler: StsRequestHandler = {
      handle: async (request) => {
        const body = requestBodyText(request.body);
        stsRequests.push({ region, request, body });
        const reply =
          stsReplies.shift() ??
          stsSuccess(new Date(clock.now() + expirationMs));
        if (reply instanceof Error) {
          throw reply;
        }
        return {
          response: {
            statusCode: reply.status,
            headers: { "content-type": "text/xml" },
            body: new TextEncoder().encode(reply.body),
          } satisfies StsHttpResponse,
        };
      },
      destroy: () => {
        destroyedStsClients += 1;
      },
    };
    return new STSClient({
      region,
      maxAttempts: 1,
      credentials: {
        accessKeyId: "fixture-access",
        secretAccessKey: "fixture-secret",
      },
      requestHandler: handler,
    });
  };

  const fetchExchange: FetchExchange = async (input, init) => {
    exchangeCalls += 1;
    let body = "";
    if (init.body instanceof URLSearchParams) {
      body = init.body.toString();
    } else if (typeof init.body === "string") {
      body = init.body;
    }
    exchangeRequests.push({ url: input.toString(), body, init });
    if (exchangeFetcher !== undefined) {
      return await exchangeFetcher(input, init);
    }
    const reply = exchangeReplies.shift() ?? successExchange();
    if (reply instanceof Error) {
      throw reply;
    }
    return typeof reply === "function" ? await reply() : reply;
  };

  const provider = createManagedOpenRouterCredentialProvider({
    configuration,
    createStsClient,
    fetchExchange,
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      clock.advance(delayMs);
    },
    random,
    timeoutMs,
  });
  return {
    provider,
    clock,
    stsRequests,
    exchangeRequests,
    sleeps,
    get stsClients() {
      return stsClients;
    },
    get destroyedStsClients() {
      return destroyedStsClients;
    },
    get exchangeCalls() {
      return exchangeCalls;
    },
  };
};

const originalWifEnvironment = () => ({
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  OPENROUTER_WIF_POLICY_ID: env.OPENROUTER_WIF_POLICY_ID,
  OPENROUTER_WIF_AUDIENCE: env.OPENROUTER_WIF_AUDIENCE,
  OPENROUTER_WIF_STS_REGION: env.OPENROUTER_WIF_STS_REGION,
});

const restoreWifEnvironment = (
  previous: ReturnType<typeof originalWifEnvironment>,
) => {
  env.OPENROUTER_API_KEY = previous.OPENROUTER_API_KEY;
  env.OPENROUTER_WIF_POLICY_ID = previous.OPENROUTER_WIF_POLICY_ID;
  env.OPENROUTER_WIF_AUDIENCE = previous.OPENROUTER_WIF_AUDIENCE;
  env.OPENROUTER_WIF_STS_REGION = previous.OPENROUTER_WIF_STS_REGION;
};

describe("managed OpenRouter credentials", () => {
  test("static credentials win over WIF and unavailable configuration refuses", async () => {
    const previous = originalWifEnvironment();
    env.OPENROUTER_API_KEY = "fixture-static-key";
    env.OPENROUTER_WIF_POLICY_ID = POLICY_ID;
    env.OPENROUTER_WIF_AUDIENCE = AUDIENCE;
    env.OPENROUTER_WIF_STS_REGION = REGION;
    try {
      const harness = createHarness({
        configuration: getManagedOpenRouterConfiguration,
      });
      const staticResult = await harness.provider.get();
      expect(staticResult).toEqual(Result.ok("fixture-static-key"));
      expect(harness.stsClients).toBe(0);
      expect(harness.exchangeCalls).toBe(0);

      env.OPENROUTER_API_KEY = undefined;
      env.OPENROUTER_WIF_POLICY_ID = undefined;
      env.OPENROUTER_WIF_AUDIENCE = undefined;
      env.OPENROUTER_WIF_STS_REGION = undefined;
      expect(getManagedOpenRouterConfiguration()).toEqual({
        type: "unavailable",
      });
      managedUnavailable(
        await createHarness({
          configuration: getManagedOpenRouterConfiguration,
        }).provider.get(),
      );
    } finally {
      restoreWifEnvironment(previous);
    }
  });

  test("requests a 900 second RS256 token for the configured audience and STS region", async () => {
    const harness = createHarness();
    const result = await harness.provider.get();
    expect(result).toEqual(Result.ok(ACCESS_TOKEN));
    expect(harness.stsClients).toBe(1);
    expect(harness.stsRequests).toHaveLength(1);
    const request = harness.stsRequests.at(0);
    if (!request) {
      throw new Error("Expected an STS request");
    }
    expect(request.region).toBe(REGION);
    expect(request.request.hostname).toBe("sts.eu-west-1.amazonaws.com");
    const fields = new URLSearchParams(harness.stsRequests.at(0)?.body ?? "");
    expect(fields.get("Action")).toBe("GetWebIdentityToken");
    expect(fields.get("Audience.member.1")).toBe(AUDIENCE);
    expect(fields.get("DurationSeconds")).toBe("900");
    expect(fields.get("SigningAlgorithm")).toBe("RS256");
    expect(harness.exchangeRequests.at(0)?.body).toContain(
      `subject_token=${encodeURIComponent(JWT)}`,
    );
  });

  test("coalesces concurrent requests and refreshes a 900 second token below ten minutes", async () => {
    const exchange = Promise.withResolvers<Response>();
    const exchangeStarted = Promise.withResolvers<undefined>();
    const harness = createHarness({
      exchangeReplies: [
        async () => {
          exchangeStarted.resolve(undefined);
          return await exchange.promise;
        },
        successExchange("next-access-token"),
      ],
    });
    const first = harness.provider.get();
    const second = harness.provider.get();
    await exchangeStarted.promise;
    exchange.resolve(successExchange());
    expect(await Promise.all([first, second])).toEqual([
      Result.ok(ACCESS_TOKEN),
      Result.ok(ACCESS_TOKEN),
    ]);
    expect(harness.stsClients).toBe(1);
    expect(harness.exchangeCalls).toBe(1);

    harness.clock.advance(300_000);
    expect(await harness.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
    expect(harness.exchangeCalls).toBe(1);
    harness.clock.advance(1);
    expect(await harness.provider.get()).toEqual(
      Result.ok("next-access-token"),
    );
    expect(harness.exchangeCalls).toBe(2);
  });

  test("clips exchange lifetime to STS expiration before deciding when to refresh", async () => {
    const harness = createHarness({ expirationMs: 720_000 });
    expect(await harness.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
    harness.clock.advance(119_999);
    expect(await harness.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
    expect(harness.exchangeCalls).toBe(1);
    harness.clock.advance(2);
    expect(await harness.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
    expect(harness.exchangeCalls).toBe(2);
  });

  test("does not cache invalid exchange responses or credentials below the handout lifetime", async () => {
    const invalidResponse = createHarness({
      exchangeReplies: [
        Response.json({ access_token: ACCESS_TOKEN, token_type: "Bearer" }),
        successExchange(),
      ],
    });
    managedUnavailable(await invalidResponse.provider.get());
    expect(await invalidResponse.provider.get()).toEqual(
      Result.ok(ACCESS_TOKEN),
    );
    expect(invalidResponse.exchangeCalls).toBe(2);

    const shortLifetime = createHarness({
      exchangeReplies: [
        successExchange("short-lived-token", 599),
        successExchange(),
      ],
    });
    managedUnavailable(await shortLifetime.provider.get());
    expect(await shortLifetime.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
    expect(shortLifetime.exchangeCalls).toBe(2);
  });

  test("honors numeric and HTTP-date Retry-After values on 429", async () => {
    for (const retryAfter of ["2", new Date(START + 3000).toUTCString()]) {
      const harness = createHarness({
        exchangeReplies: [
          new Response(null, {
            status: 429,
            headers: { "retry-after": retryAfter },
          }),
          successExchange(),
        ],
      });
      expect(await harness.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
      expect(harness.exchangeCalls).toBe(2);
      expect(harness.sleeps.at(0)).toBe(retryAfter === "2" ? 2000 : 3000);
    }
  });

  test("exhausts missing and malformed Retry-After with bounded jitter backoff", async () => {
    for (const retryAfter of [undefined, "not-a-date"]) {
      const retryResponse = () =>
        new Response(null, {
          status: 429,
          ...(retryAfter === undefined
            ? {}
            : { headers: { "retry-after": retryAfter } }),
        });
      const harness = createHarness({
        exchangeReplies: [retryResponse(), retryResponse(), retryResponse()],
        random: () => 0,
      });
      managedUnavailable(await harness.provider.get());
      expect(harness.exchangeCalls).toBe(3);
      expect(harness.sleeps).toEqual([125, 250]);
    }
  });

  test("does not hand out a token when exchange latency consumes its lifetime", async () => {
    const clock = createClock();
    const harness = createHarness({
      clock,
      exchangeReplies: [
        async () => {
          clock.advance(300_001);
          return successExchange();
        },
        async () => {
          clock.advance(300_001);
          return successExchange();
        },
      ],
    });
    managedUnavailable(await harness.provider.get());
    expect(harness.exchangeCalls).toBe(1);
    managedUnavailable(await harness.provider.get());
    expect(harness.exchangeCalls).toBe(2);
  });

  test("bounds a hanging successful response body parse and stops after three attempts", async () => {
    const hangingBody = new Response("{}", { status: 200 });
    hangingBody.json = async () => await new Promise<unknown>(() => {});
    const harness = createHarness({
      timeoutMs: 5,
      exchangeFetcher: async () => hangingBody,
    });
    managedUnavailable(await harness.provider.get());
    expect(harness.exchangeCalls).toBe(3);
  });

  test("discards a pending federation exchange after configuration switches to static", async () => {
    let configuration: ReturnType<ProviderOptions["configuration"]> =
      federatedConfiguration;
    const exchange = Promise.withResolvers<Response>();
    const exchangeStarted = Promise.withResolvers<undefined>();
    const harness = createHarness({
      configuration: () => configuration,
      exchangeReplies: [
        async () => {
          exchangeStarted.resolve(undefined);
          return await exchange.promise;
        },
      ],
    });
    const pendingFederated = harness.provider.get();
    await exchangeStarted.promise;

    configuration = {
      type: "static",
      apiKey: "fixture-replacement-static-key",
    };
    expect(await harness.provider.get()).toEqual(
      Result.ok("fixture-replacement-static-key"),
    );
    exchange.resolve(successExchange("stale-federated-token"));
    managedUnavailable(await pendingFederated);

    configuration = federatedConfiguration;
    expect(await harness.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
    expect(harness.exchangeCalls).toBe(2);
  });

  test("retries 503 and network failures no more than three times", async () => {
    const unavailable = () => new Response(null, { status: 503 });
    const serviceUnavailable = createHarness({
      exchangeReplies: [unavailable(), unavailable(), unavailable()],
    });
    managedUnavailable(await serviceUnavailable.provider.get());
    expect(serviceUnavailable.exchangeCalls).toBe(3);

    const networkFailure = createHarness({
      exchangeReplies: [
        new Error("fixture network failure"),
        new Error("fixture network failure"),
        new Error("fixture network failure"),
      ],
    });
    managedUnavailable(await networkFailure.provider.get());
    expect(networkFailure.exchangeCalls).toBe(3);
  });

  test("does not retry invalid_grant or an ordinary 500 response", async () => {
    for (const response of [
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      new Response(null, { status: 500 }),
    ]) {
      const harness = createHarness({ exchangeReplies: [response] });
      managedUnavailable(await harness.provider.get());
      expect(harness.exchangeCalls).toBe(1);
    }
  });

  test("fails closed during a long Retry-After cooldown and resumes at its deadline", async () => {
    const harness = createHarness({
      exchangeReplies: [
        new Response(null, {
          status: 429,
          headers: { "retry-after": "6" },
        }),
      ],
    });
    managedUnavailable(await harness.provider.get());
    expect(harness.exchangeCalls).toBe(1);
    const stsRequestsBeforeCooldown = harness.stsRequests.length;
    managedUnavailable(await harness.provider.get());
    expect(harness.exchangeCalls).toBe(1);
    expect(harness.stsRequests).toHaveLength(stsRequestsBeforeCooldown);

    harness.clock.advance(6000);
    expect(await harness.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
    expect(harness.exchangeCalls).toBe(2);
  });

  test("bounds a hanging exchange with the injected timeout", async () => {
    const harness = createHarness({
      timeoutMs: 5,
      exchangeFetcher: async () => await new Promise<Response>(() => {}),
    });
    managedUnavailable(await harness.provider.get());
    expect(harness.exchangeCalls).toBe(3);
  });

  test("fails closed when STS fails and retries session escalation with a fresh client once", async () => {
    const failed = createHarness({
      stsReplies: [new Error("fixture STS transport failure")],
    });
    managedUnavailable(await failed.provider.get());
    expect(failed.stsClients).toBe(1);
    expect(failed.exchangeCalls).toBe(0);

    const escalated = createHarness({
      stsReplies: [
        stsFailure("SessionDurationEscalationException"),
        stsSuccess(new Date(START + 900_000)),
      ],
    });
    expect(await escalated.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
    expect(escalated.stsClients).toBe(2);
    expect(escalated.destroyedStsClients).toBe(2);
    expect(escalated.stsRequests).toHaveLength(2);
  });

  test("rejects backward clock movement and refreshes after a forward jump", async () => {
    const backwards = createHarness();
    expect(await backwards.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
    backwards.clock.setWall(START - 1);
    managedUnavailable(await backwards.provider.get());
    expect(backwards.exchangeCalls).toBe(1);

    const backwardsMonotonic = createHarness();
    expect(await backwardsMonotonic.provider.get()).toEqual(
      Result.ok(ACCESS_TOKEN),
    );
    backwardsMonotonic.clock.setMonotonic(-1);
    managedUnavailable(await backwardsMonotonic.provider.get());
    expect(backwardsMonotonic.exchangeCalls).toBe(1);

    const forwards = createHarness();
    expect(await forwards.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
    forwards.clock.advance(901_000);
    expect(await forwards.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
    expect(forwards.exchangeCalls).toBe(2);
  });

  test("invalidates only the matching cached token", async () => {
    const harness = createHarness({
      exchangeReplies: [
        successExchange("first-access-token"),
        successExchange("second-access-token"),
      ],
    });
    expect(await harness.provider.get()).toEqual(
      Result.ok("first-access-token"),
    );
    harness.provider.invalidate("stale-access-token");
    expect(await harness.provider.get()).toEqual(
      Result.ok("first-access-token"),
    );
    expect(harness.exchangeCalls).toBe(1);
    harness.provider.invalidate("first-access-token");
    expect(await harness.provider.get()).toEqual(
      Result.ok("second-access-token"),
    );
    expect(harness.exchangeCalls).toBe(2);
  });

  test("metrics and logs exclude tokens and keep dimensions bounded", async () => {
    const lines: string[] = [];
    const logger = installRecordingLogger();
    setMetricLineSinkForTesting((line) => lines.push(line));
    try {
      const harness = createHarness();
      expect(await harness.provider.get()).toEqual(Result.ok(ACCESS_TOKEN));
      managedUnavailable(
        await createHarness({
          configuration: () => ({ type: "unavailable" }),
        }).provider.get(),
      );

      const telemetry = JSON.stringify({
        metrics: lines,
        logs: logger.records,
      });
      expect(telemetry).not.toContain(JWT);
      expect(telemetry).not.toContain(ACCESS_TOKEN);
      const metricSchema = v.object({
        _aws: v.object({
          CloudWatchMetrics: v.array(
            v.object({
              Dimensions: v.array(v.array(v.string())),
              Metrics: v.array(v.object({ Name: v.string() })),
            }),
          ),
        }),
      });
      const dimensions = lines.flatMap((line) =>
        v
          .parse(metricSchema, JSON.parse(line))
          ._aws.CloudWatchMetrics.map((metric) => metric.Dimensions),
      );
      expect(dimensions).toContainEqual([["outcome"]]);
      expect(dimensions).toContainEqual([[]]);
      expect(
        dimensions.every(
          (value) =>
            JSON.stringify(value) === JSON.stringify([["outcome"]]) ||
            JSON.stringify(value) === JSON.stringify([[]]),
        ),
      ).toBe(true);
    } finally {
      resetMetricLineSinkForTesting();
      logger.restore();
    }
  });
});
