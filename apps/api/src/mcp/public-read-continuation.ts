import { panic } from "better-result";
import * as v from "valibot";

import { sleep } from "@stll/concurrency/sleep";
import { sha256Hex } from "@stll/sha256/bun";

import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import { env } from "@/api/env";
import { runOutsideQueryCounter } from "@/api/lib/db-query-counter";
import {
  ActionAdmissionError,
  actionAdmissionRefusal,
} from "@/api/lib/errors/action-admission-error";
import { canonicalCorpusJson } from "@/api/lib/legal-search/corpus-aggregate-cache";
import {
  runAsCorpusSearchCaller,
  runWithPatientCorpusReads,
} from "@/api/lib/legal-search/corpus-index-admission";
import { estimatedCorpusSearchWaitMs } from "@/api/lib/legal-search/corpus-index-client";
import {
  type ContinuationCodec,
  type ContinuationPhase,
  type ContinuationRunVerdict,
  type ContinuationStore,
  createPublicReadContinuation,
  type PublicReadContinuationLimits,
} from "@/api/lib/legal-search/public-read-continuation";
import { createContinuationStore } from "@/api/lib/legal-search/public-read-continuation-store";
import { publicReadTimeoutError } from "@/api/lib/legal-search/public-read-timeout";
import {
  runOutsidePublicReadScope,
  runWithPublicReadScope,
} from "@/api/lib/legal-search/public-read-timeout-context";
import {
  remainingRequestBudgetMs,
  runWithinRequestLatencyBudget,
} from "@/api/lib/load/request-latency-budget";
import { mcpPublicReadCallerKey } from "@/api/lib/rate-limit/mcp-public-read-admission";
import { isRecord } from "@/api/lib/type-guards";
import type { McpRequestContext } from "@/api/mcp/context";
import type {
  InternalToolResult,
  TypedMcpToolResponse,
} from "@/api/mcp/tool-types";
import {
  internalFailureResult,
  isCaseLawSearchTimeout,
  structuredErrorResult,
  toolDataResult,
} from "@/api/mcp/tool-utils";

/**
 * The agent-facing half of the overload continuation
 * (`lib/legal-search/public-read-continuation.ts`).
 *
 * The answer is judged and stored before anything caller-specific is applied:
 * the handler's response here is pre-egress, so anonymization and windowing
 * still run per call, and a stored answer carries nothing of the caller who
 * ran it. The work is scoped to the organization, because a handler's output
 * can depend on the organization's page limit.
 */

/** How long a call holds its caller before answering that the work continues. */
export const PUBLIC_READ_RESPONSE_DEADLINE_MS = 6000;
/** What a call keeps of its latency budget to shape and write the response. */
const RESPONSE_RESERVE_MS = 1500;
/** How long a detached run may take; its reads are clamped to this. */
const PUBLIC_READ_RUN_BUDGET_MS = 60_000;

export const PUBLIC_READ_CONTINUATION_LIMITS: PublicReadContinuationLimits = {
  leaseMs: 15_000,
  runBudgetMs: PUBLIC_READ_RUN_BUDGET_MS,
  retentionMs: 10 * 60 * 1000,
  incompleteRetentionMs: 60 * 1000,
  maxResultBytes: 1024 * 1024,
  maxAttempts: 5,
  perCallerConcurrency: env.MCP_PUBLIC_READ_CALLER_CONCURRENCY,
  perCallerQueue: 32,
  processConcurrency: 48,
  processQueue: 256,
  followPollMs: 400,
  minRetryAfterMs: 1000,
  maxRetryAfterMs: 15_000,
};

/** What the running answer tells a model to do next. */
const runningMessage = (
  toolName: ContinuableToolName,
  phase: ContinuationPhase,
): string =>
  phase === "not_started"
    ? `Nothing has failed, but the server is at capacity and this ${toolName} call has not started. Call ${toolName} again after retryAfterMs with the same arguments plus continuation_token.`
    : `Nothing has failed. This ${toolName} call is still ${phase === "queued" ? "queued" : "running"} and the results are not complete. Call ${toolName} again after retryAfterMs with the same arguments plus continuation_token. Do not report the search as empty or finished.`;

type ContinuableToolName = "search_case_law" | "search_legislation";

/** The tools whose calls answer through the continuation. */
export const CONTINUABLE_PUBLIC_READ_TOOLS: ReadonlySet<string> = new Set([
  "search_case_law",
  "search_legislation",
] satisfies ContinuableToolName[]);

const OVERLOAD_ERROR_CODES: ReadonlySet<string> = new Set([
  "public_read_timeout",
  // What a case-law search that ran out of its time budget answers.
  "upstream_unavailable",
]);

const INDEX_UNAVAILABLE_CODE = "search_index_unavailable";

/**
 * Running out of time is load, so the next call runs it again. An index that
 * cannot be reached is not load, and stays the typed error it always was: a
 * full read queue never gets this far, because a detached run waits it out.
 */
const isOverload = (error: unknown): boolean =>
  isCaseLawSearchTimeout(error) || publicReadTimeoutError(error) !== null;

/**
 * Only a response the work finished may be served to a new call. A page cut by
 * the time budget is honest (it says so), so its own token gets it, but the
 * next identical call deserves another try.
 */
const judgeToolResponse = <TData>(
  response: InternalToolResult<TData>,
): ContinuationRunVerdict => {
  if (response.status === "error") {
    if (response.error.type !== "structured") {
      return { type: "complete" };
    }
    if (OVERLOAD_ERROR_CODES.has(response.error.code)) {
      return { type: "overloaded" };
    }
    // The answer of this moment: its token sees it, a new call asks again.
    return response.error.code === INDEX_UNAVAILABLE_CODE
      ? { type: "incomplete" }
      : { type: "complete" };
  }
  const { data } = response;
  return isRecord(data) &&
    isRecord(data["paginationOutcome"]) &&
    data["paginationOutcome"]["reason"] === "time_budget"
    ? { type: "incomplete" }
    : { type: "complete" };
};

const isToolResponse = <TData>(
  value: unknown,
): value is InternalToolResult<TData> =>
  isRecord(value) &&
  ((value["status"] === "success" && "data" in value) ||
    (value["status"] === "error" && isRecord(value["error"])));

type CreateToolContinuationOptions<P> = {
  store?: ContinuationStore;
  ownerId?: string;
  limits?: PublicReadContinuationLimits;
  progress: (value: unknown) => P | null;
};

export const createToolContinuation = <
  TSchema extends v.GenericSchema,
  TData,
  P,
>(
  argsSchema: TSchema,
  {
    store = createContinuationStore(),
    ownerId = Bun.randomUUIDv7(),
    limits = PUBLIC_READ_CONTINUATION_LIMITS,
    progress,
  }: CreateToolContinuationOptions<P>,
) => {
  const codec: ContinuationCodec<
    v.InferOutput<TSchema>,
    InternalToolResult<TData>,
    P
  > = {
    args: (value) => {
      const parsed = v.safeParse(argsSchema, value);
      return parsed.success ? parsed.output : null;
    },
    result: (value) => (isToolResponse<TData>(value) ? value : null),
    progress,
  };
  return createPublicReadContinuation({
    codec,
    store,
    ownerId,
    limits,
    now: () => performance.now(),
    sleep,
    estimateQueueWaitMs: estimatedCorpusSearchWaitMs,
  });
};

type ToolContinuation<TArgs, TData, P> = ReturnType<
  typeof createPublicReadContinuation<TArgs, InternalToolResult<TData>, P>
>;

export type PublicReadRunning<P> = {
  status: "running";
  continuationToken: string;
  retryAfterMs: number;
  phase: ContinuationPhase;
  message: string;
  partial: P | null;
};

const continuationExpiredResult = (toolName: ContinuableToolName) =>
  structuredErrorResult({
    code: "continuation_expired",
    message: "This continuation_token is unknown or has expired",
    hint: `Call ${toolName} again with the original arguments and without continuation_token; the search runs again.`,
  });

const publicReadUnfinishedResult = (toolName: ContinuableToolName) =>
  structuredErrorResult({
    code: "public_read_unfinished",
    message: "This search could not finish under the current load",
    hint: `Nothing was returned, so do not treat it as an empty result. Call ${toolName} later, or narrow it with fewer queries or a filter.`,
  });

/** A run that failed for a reason load does not explain, as its typed error. */
const failedReadResult = (error: unknown) =>
  ActionAdmissionError.is(error)
    ? structuredErrorResult(actionAdmissionRefusal(error))
    : internalFailureResult(error, "mcp.publicReadContinuation");

const continuationWorkId = (
  toolName: ContinuableToolName,
  scope: string,
  args: unknown,
): string =>
  sha256Hex(canonicalCorpusJson({ toolName, scope, args })).slice(0, 32);

type RunContinuablePublicReadOptions<TArgs, TData, P> = {
  toolName: ContinuableToolName;
  continuation: ToolContinuation<TArgs, TData, P>;
  args: TArgs;
  continuationToken: string | undefined;
  context: Pick<
    McpRequestContext,
    "organizationId" | "userId" | "clientId" | "testDependencies"
  >;
  /** The read itself. Runs detached: nothing from the request may reach it. */
  execute: (
    args: TArgs,
    run: { signal: AbortSignal; reportProgress: (progress: P) => void },
  ) => Promise<InternalToolResult<TData>>;
  /** Per-caller shaping of a finished answer, which is never stored. */
  finish: (
    response: InternalToolResult<TData>,
  ) => Promise<InternalToolResult<TData>>;
};

export const runContinuablePublicRead = async <TArgs, TData, P>({
  toolName,
  continuation,
  args,
  continuationToken,
  context,
  execute,
  finish,
}: RunContinuablePublicReadOptions<TArgs, TData, P>): Promise<
  TypedMcpToolResponse<TData | PublicReadRunning<P>>
> => {
  const scope = context.organizationId;
  const callerWorkId = continuationWorkId(toolName, scope, args);
  let workArgs = args;
  let via: "call" | "token" = "call";
  if (continuationToken !== undefined) {
    const resolved = await continuation.resolveToken(continuationToken, scope);
    if (resolved.status === "resolved") {
      workArgs = resolved.args;
      via = "token";
    } else if (continuationToken !== callerWorkId) {
      return continuationExpiredResult(toolName);
    }
  }
  const caller = mcpPublicReadCallerKey(context);
  const statementBudgetMs = PUBLIC_READ_STATEMENT_TIMEOUT_MS.search;
  const outcome = await continuation.attach({
    via,
    responseDeadlineMs: Math.min(
      context.testDependencies?.publicReadResponseDeadlineMs ??
        PUBLIC_READ_RESPONSE_DEADLINE_MS,
      Math.max(
        0,
        (remainingRequestBudgetMs() ?? Number.POSITIVE_INFINITY) -
          RESPONSE_RESERVE_MS,
      ),
    ),
    work: {
      workId: continuationToken ?? callerWorkId,
      caller,
      scope,
      args: workArgs,
      isOverload,
      judge: judgeToolResponse,
      // Out of the request's scopes: its public-read scope settles only after
      // every read inside it, and its budget would end the run with the call.
      run: async (runArgs, run) =>
        await runOutsideQueryCounter(
          async () =>
            await runOutsidePublicReadScope(
              async () =>
                await runWithinRequestLatencyBudget(
                  {
                    label: `${toolName}.continuation`,
                    budgetMs: PUBLIC_READ_RUN_BUDGET_MS,
                  },
                  async () =>
                    await runAsCorpusSearchCaller(caller, async () => {
                      const read = await runWithPatientCorpusReads(
                        async () =>
                          await runWithPublicReadScope(
                            {
                              budgetMs: statementBudgetMs,
                              signal: run.signal,
                            },
                            async () => await execute(runArgs, run),
                          ),
                      );
                      return read;
                    }),
                ),
            ),
        ),
    },
  });
  switch (outcome.status) {
    case "finished":
      return await finish(outcome.result);
    case "running":
      return toolDataResult<PublicReadRunning<P>, PublicReadRunning<P>>({
        status: "running",
        continuationToken: outcome.token,
        retryAfterMs: outcome.retryAfterMs,
        phase: outcome.phase,
        message: runningMessage(toolName, outcome.phase),
        partial: outcome.progress,
      });
    case "exhausted":
      return publicReadUnfinishedResult(toolName);
    case "failed":
      return failedReadResult(outcome.error);
    default:
      outcome satisfies never;
      return panic("Unhandled continuation outcome");
  }
};
