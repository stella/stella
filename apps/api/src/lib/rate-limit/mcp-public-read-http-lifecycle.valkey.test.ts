import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";

import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import {
  type CorpusIndexError,
  getCorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  runWithPublicReadScope,
  withPublicReadIo,
} from "@/api/lib/legal-search/public-read-timeout-context";
import { createRedisClient } from "@/api/lib/redis-client";
import { isRecord } from "@/api/lib/type-guards";

import {
  ACQUIRE_SCRIPT,
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
} from "./concurrency-lease";
import { withMcpPublicReadAdmission } from "./mcp-public-read-admission";

const runValkeyTests = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";
const caller = () => ({
  organizationId: toSafeId<"organization">(
    `http_lifecycle_${Bun.randomUUIDv7()}`,
  ),
  userId: toSafeId<"user">("http_lifecycle_user"),
  clientId: "http_lifecycle_client",
});
const SEARCH_RESULT = JSON.stringify({ num_hits: 0, hits: [], snippets: [] });
const SEARCH_ENDPOINT_ENV = "CORPUS_INDEX_Q09_SEARCH_ENDPOINT" as const;
const MUTATION_ENDPOINT_ENV = "CORPUS_INDEX_Q09_ENDPOINT" as const;

const withStore = async (
  run: (
    client: Pick<ReturnType<typeof createRedisClient>, "send">,
  ) => Promise<void>,
) => {
  const client = createRedisClient({ storeClass: "cache" });
  await client.connect();
  try {
    await run({
      send: async (command, args) => await client.send(command, args),
    });
  } finally {
    client.close();
  }
};

const withSearchServer = async (
  fetch: (request: Request) => Promise<Response>,
  run: (url: string) => Promise<void>,
) => {
  const originalMutationEndpoint = envBase[MUTATION_ENDPOINT_ENV];
  const originalSearchEndpoint = envBase[SEARCH_ENDPOINT_ENV];
  const server = Bun.serve({
    port: 0,
    fetch,
  });
  Object.assign(envBase, {
    [MUTATION_ENDPOINT_ENV]: server.url.href,
    [SEARCH_ENDPOINT_ENV]: server.url.href,
  });
  try {
    await run(server.url.href);
  } finally {
    await server.stop(true);
    Object.assign(envBase, {
      [MUTATION_ENDPOINT_ENV]: originalMutationEndpoint,
      [SEARCH_ENDPOINT_ENV]: originalSearchEndpoint,
    });
  }
};

const bodyPending = () => {
  const started = Promise.withResolvers<undefined>();
  const cancelled = Promise.withResolvers<undefined>();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let settled = false;
  let wasCancelled = false;
  return {
    started: started.promise,
    cancelled: cancelled.promise,
    wasCancelled: () => wasCancelled,
    response: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
            started.resolve(undefined);
          },
          cancel() {
            settled = true;
            wasCancelled = true;
            cancelled.resolve(undefined);
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    finish: () => {
      if (settled || controller === undefined) {
        return;
      }
      settled = true;
      controller.enqueue(new TextEncoder().encode(SEARCH_RESULT));
      controller.close();
    },
  };
};

const search = async (query: string) =>
  await getCorpusIndexClient("q09").search({
    observer: "unobserved",
    indexId: "case_law_v8_cs_sk",
    query,
    maxHits: 1,
  });

const requireSearchResult = async (
  request: Promise<Result<unknown, CorpusIndexError>>,
) => {
  const result = await request;
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

if (!runValkeyTests || !process.env["REDIS_URL"]) {
  describe.skip("MCP public-read HTTP lifecycle (Valkey)", () => {
    test("requires Valkey", () => {});
  });
} else {
  describe("MCP public-read HTTP lifecycle (Valkey)", () => {
    for (const pendingPhase of ["headers", "body"] as const) {
      test(`keeps a caller slot through a failed sibling and pending ${pendingPhase}`, async () => {
        await withStore(async (client) => {
          const pendingBody = bodyPending();
          const failedResponse = Promise.withResolvers<undefined>();
          const headersPending = Promise.withResolvers<undefined>();
          const allowHeaders = Promise.withResolvers<undefined>();
          const server = async (request: Request) => {
            const body: unknown = await request.json();
            if (isRecord(body) && body["query"] === "text:fail") {
              failedResponse.resolve(undefined);
              return Response.json(
                { error: "fixture unavailable" },
                { status: 503 },
              );
            }
            if (pendingPhase === "headers") {
              headersPending.resolve(undefined);
              await allowHeaders.promise;
              return Response.json({ num_hits: 0, hits: [], snippets: [] });
            }
            return pendingBody.response();
          };
          await withSearchServer(server, async () => {
            const identity = caller();
            let releaseAttempts = 0;
            const redis = {
              send: async (command: string, args: string[]) => {
                if (args.at(0) === RELEASE_SCRIPT) {
                  releaseAttempts += 1;
                }
                return await client.send(command, args);
              },
            };
            const callbackSettled = Promise.withResolvers<undefined>();
            const run = withMcpPublicReadAdmission({
              caller: identity,
              limit: 1,
              redis,
              run: async (signal) =>
                await runWithPublicReadScope(
                  { budgetMs: 30_000, signal },
                  async () => {
                    try {
                      return await Promise.all([
                        requireSearchResult(search("text:fail")),
                        requireSearchResult(search("text:pending")),
                      ]);
                    } finally {
                      callbackSettled.resolve(undefined);
                    }
                  },
                ),
            });
            try {
              await Promise.all([
                failedResponse.promise,
                pendingPhase === "headers"
                  ? headersPending.promise
                  : pendingBody.started,
              ]);
              await callbackSettled.promise;
              const probe = await withMcpPublicReadAdmission({
                caller: identity,
                redis,
                limit: 1,
                run: async () => "probe",
              });
              if (Result.isOk(probe) || !ActionAdmissionError.is(probe.error)) {
                panic("Expected the pending read to retain its caller lease");
              }
              expect(probe.error.code).toBe("action_concurrency_busy");
              expect(releaseAttempts).toBe(0);

              if (pendingPhase === "headers") {
                allowHeaders.resolve(undefined);
              } else {
                pendingBody.finish();
              }
              const admittedOutcome = await run;
              const outcome = admittedOutcome.andThen(({ value }) => value);
              expect(Result.isError(outcome)).toBe(true);
              expect(releaseAttempts).toBe(1);
              expect(
                await withMcpPublicReadAdmission({
                  caller: identity,
                  redis: client,
                  limit: 1,
                  run: async () => "next",
                }),
              ).toEqual(Result.ok({ status: "leased", value: "next" }));
            } finally {
              allowHeaders.resolve(undefined);
              pendingBody.finish();
              await Promise.allSettled([run]);
            }
          });
        });
      });
    }

    test("lease loss cancels the response body and waits for transport settlement before release", async () => {
      await withStore(async (client) => {
        const identity = caller();
        const acquired = Promise.withResolvers<{
          key: string;
          leaseId: string;
        }>();
        const renewed = Promise.withResolvers<unknown>();
        const cancellationStarted = Promise.withResolvers<undefined>();
        const allowCancellation = Promise.withResolvers<undefined>();
        const cancellationSettled = Promise.withResolvers<undefined>();
        const requestSettled = Promise.withResolvers<undefined>();
        const releaseState = Promise.withResolvers<{
          bodySettled: boolean;
          requestSettled: boolean;
        }>();
        let renew: (() => void) | undefined;
        let cleanupAttempts = 0;
        let requestSettledValue = false;
        let bodySettledValue = false;
        const redis = {
          send: async (command: string, args: string[]) => {
            const script = args.at(0);
            if (script === ACQUIRE_SCRIPT) {
              const key = args.at(2);
              const leaseId = args.at(7);
              if (key === undefined || leaseId === undefined) {
                panic("Expected acquired lease details");
              }
              acquired.resolve({ key, leaseId });
            }
            if (script === RELEASE_SCRIPT) {
              cleanupAttempts += 1;
              releaseState.resolve({
                bodySettled: bodySettledValue,
                requestSettled: requestSettledValue,
              });
            }
            const result = await client.send(command, args);
            if (script === RENEW_SCRIPT) {
              renewed.resolve(result);
            }
            return result;
          },
        };
        const run = withMcpPublicReadAdmission({
          caller: identity,
          limit: 1,
          redis,
          timing: {
            now: () => performance.now(),
            schedule: (callback) => {
              renew = callback;
              return () => undefined;
            },
          },
          run: async (signal) =>
            await runWithPublicReadScope(
              { budgetMs: 30_000, signal },
              async () =>
                await withPublicReadIo(
                  "corpus-index",
                  async (io) =>
                    await io.fetch(
                      "https://corpus.fixture/search",
                      { timeoutMs: 30_000, signal: io.signal },
                      async (response) => {
                        try {
                          return await response.text();
                        } finally {
                          requestSettledValue = true;
                          requestSettled.resolve(undefined);
                        }
                      },
                      async (_input, init) => {
                        if (init?.signal === undefined) {
                          panic("Expected a public-read transport signal");
                        }
                        return new Response(
                          new ReadableStream<Uint8Array>({
                            cancel: async () => {
                              cancellationStarted.resolve(undefined);
                              await allowCancellation.promise;
                              bodySettledValue = true;
                              cancellationSettled.resolve(undefined);
                            },
                          }),
                          { headers: { "content-type": "application/json" } },
                        );
                      },
                    ),
                ),
            ),
        });
        try {
          const { key, leaseId } = await acquired.promise;
          expect(await client.send("ZREM", [key, leaseId])).toBe(1);
          if (renew === undefined) {
            panic("Expected a scheduled lease renewal");
          }
          renew();
          expect(await renewed.promise).toBe(0);
          await cancellationStarted.promise;
          await requestSettled.promise;
          await setImmediate();
          expect(bodySettledValue).toBe(false);
          expect(cleanupAttempts).toBe(0);

          allowCancellation.resolve(undefined);
          await cancellationSettled.promise;
          const admittedOutcome = await run;
          const outcome = admittedOutcome.andThen(({ value }) => value);
          if (Result.isOk(outcome) || !ActionAdmissionError.is(outcome.error)) {
            panic("Expected typed admission-unavailable cancellation");
          }
          expect(outcome.error.reason).toBe("unavailable");
          expect(outcome.error.code).toBe("action_admission_unavailable");
          expect(cleanupAttempts).toBe(1);
          expect(await releaseState.promise).toEqual({
            bodySettled: true,
            requestSettled: true,
          });
        } finally {
          allowCancellation.resolve(undefined);
          await Promise.allSettled([run]);
        }
      });
    });
  });
}
