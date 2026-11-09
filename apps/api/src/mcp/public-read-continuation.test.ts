import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { toSafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import type { PublicReadContinuationLimits } from "@/api/lib/legal-search/public-read-continuation";
import type { withMcpPublicReadAdmission } from "@/api/lib/rate-limit/mcp-public-read-admission";
import { isRecord } from "@/api/lib/type-guards";
import {
  createToolContinuation,
  runContinuablePublicRead,
} from "@/api/mcp/public-read-continuation";
import { MCP_INTERNAL_TOOL_FAILURE } from "@/api/mcp/tool-call-outcome";
import type { InternalToolResult } from "@/api/mcp/tool-types";
import { structuredErrorResult, toolDataResult } from "@/api/mcp/tool-utils";
import { createFakeContinuationStore } from "@/api/tests/helpers/fake-continuation-store";

const limits: PublicReadContinuationLimits = {
  leaseMs: 5000,
  runBudgetMs: 5000,
  retentionMs: 60_000,
  incompleteRetentionMs: 5000,
  maxResultBytes: 1024 * 1024,
  maxAttempts: 5,
  perCallerConcurrency: 4,
  perCallerQueue: 8,
  processConcurrency: 8,
  processQueue: 16,
  followPollMs: 5,
  minRetryAfterMs: 50,
  maxRetryAfterMs: 1000,
};

type Data = Record<string, unknown>;
type AdmitPublicRead = typeof withMcpPublicReadAdmission;

const argsSchema = v.object({ query: v.string() });

const organizationId = toSafeId<"organization">("org_1");
const userId = toSafeId<"user">("user_1");

const admitAlways: AdmitPublicRead = async ({ run }) =>
  await Result.tryPromise({
    try: async () => ({
      status: "leased" as const,
      value: await run(new AbortController().signal),
    }),
    catch: (error: unknown) => error,
  });

const harness = (
  answer: () => InternalToolResult<Data>,
  admitPublicRead: AdmitPublicRead = admitAlways,
) => {
  const { store } = createFakeContinuationStore();
  const continuation = createToolContinuation<typeof argsSchema, Data, null>(
    argsSchema,
    {
      store,
      ownerId: "a",
      limits,
      progress: () => null,
    },
  );
  let runs = 0;
  const gate = Promise.withResolvers<undefined>();
  const call = async (deadlineMs: number, continuationToken?: string) =>
    await runContinuablePublicRead({
      toolName: "search_case_law",
      continuation,
      args: { query: "smlouva" },
      continuationToken,
      context: {
        organizationId,
        userId,
        clientId: null,
        testDependencies: {
          publicReadResponseDeadlineMs: deadlineMs,
          admitPublicRead,
        },
      },
      execute: async () => {
        runs += 1;
        await gate.promise;
        return answer();
      },
      finish: async (response) => await Promise.resolve(response),
    });
  return {
    store,
    call,
    runs: () => runs,
    release: () => {
      gate.resolve(undefined);
    },
  };
};

const fieldOf = (value: unknown, field: string): unknown =>
  isRecord(value) ? value[field] : null;

const tokenOf = (response: unknown): string => {
  const token = fieldOf(fieldOf(response, "data"), "continuationToken");
  if (typeof token !== "string") {
    throw new TypeError("expected a running answer");
  }
  return token;
};

/** One slow run whose token is issued, then collected once it has ended. */
const collected = async ({ call, release }: ReturnType<typeof harness>) => {
  const token = tokenOf(await call(0));
  const joined = call(2000);
  release();
  await joined;
  return { token, collected: await call(2000, token) };
};

describe("public read continuation over MCP", () => {
  test.each([
    {
      name: "a page whose partial-match top-up was skipped",
      answer: () =>
        toolDataResult<Data, Data>({
          warnings: [{ code: "partial_matches_unread" }],
        }),
    },
    {
      name: "an internal failure",
      answer: () =>
        structuredErrorResult({
          code: "internal_error",
          message: "Tool execution failed",
        }),
    },
  ])(
    "$name serves its token, and a new call asks again",
    async ({ answer }) => {
      const run = harness(answer);
      await collected(run);
      expect(run.runs()).toBe(1);
      await run.call(2000);
      expect(run.runs()).toBe(2);
    },
  );

  test("a stored internal failure still reads as one when collected", async () => {
    const { collected: response } = await collected(
      harness(() =>
        structuredErrorResult({
          code: "internal_error",
          message: "Tool execution failed",
        }),
      ),
    );
    const error = fieldOf(response, "error");
    expect(isRecord(error) && MCP_INTERNAL_TOOL_FAILURE in error).toBe(true);
  });

  test("a token matching its own arguments still collects an answer kept for tokens", async () => {
    const run = harness(() =>
      toolDataResult<Data, Data>({
        paginationOutcome: { reason: "time_budget" },
      }),
    );
    const { token } = await collected(run);
    expect(run.runs()).toBe(1);
    await run.call(2000, token);
    expect(run.runs()).toBe(1);
  });

  test("a stored success that is not an object is not served", async () => {
    const run = harness(() => toolDataResult<Data, Data>({ fresh: true }));
    const { token } = await collected(run);
    expect(run.runs()).toBe(1);
    Result.unwrap(
      await run.store.writeFinished(
        token,
        JSON.stringify({
          complete: true,
          result: { status: "success", data: null },
        }),
        60_000,
      ),
    );
    await run.call(2000, token);
    expect(run.runs()).toBe(2);
  });

  test("a full fleet-wide caller pool is waited out, not refused", async () => {
    let refusals = 1;
    const run = harness(
      () => toolDataResult<Data, Data>({ ok: true }),
      async ({ run: admitted }) => {
        if (refusals > 0) {
          refusals -= 1;
          return Result.err(
            new ActionAdmissionError({
              message: "Concurrent action limit reached",
              reason: "busy",
            }),
          );
        }
        return Result.ok({
          status: "leased" as const,
          value: await admitted(new AbortController().signal),
        });
      },
    );
    run.release();
    const response = await run.call(3000);
    expect(response).toMatchObject({ status: "success", data: { ok: true } });
    expect(run.runs()).toBe(1);
  });
});
