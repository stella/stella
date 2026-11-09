import { panic, Result } from "better-result";
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
  type ContinuationWork,
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
import { getRequestId } from "@/api/lib/observability/request-context";
import {
  mcpPublicReadCallerKey,
  withMcpPublicReadAdmission,
} from "@/api/lib/rate-limit/mcp-public-read-admission";
import { isRecord } from "@/api/lib/type-guards";
import type { McpRequestContext } from "@/api/mcp/context";
import { MCP_INTERNAL_TOOL_FAILURE } from "@/api/mcp/tool-call-outcome";
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

const FLEET_SLOT_RETRY_MS = 500;

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
    ? `Nothing has failed, but the server is at capacity and this ${toolName} call is not running now. Call ${toolName} again after retryAfterMs with the same arguments plus continuation_token.`
    : `Nothing has failed. This ${toolName} call is still ${phase === "queued" ? "queued" : "running"} and the results are not complete. Call ${toolName} again after retryAfterMs with the same arguments plus continuation_token. Do not report the search as empty or finished.`;

type ContinuableToolName = "search_case_law" | "search_legislation" | "search";

/** The tools whose calls answer through the continuation. */
export const CONTINUABLE_PUBLIC_READ_TOOLS: ReadonlySet<string> = new Set([
  "search_case_law",
  "search_legislation",
  "search",
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
    return response.error.code === INDEX_UNAVAILABLE_CODE ||
      response.error.code === "internal_error"
      ? { type: "incomplete" }
      : { type: "complete" };
  }
  return isShapedByLoad(response.data)
    ? { type: "incomplete" }
    : { type: "complete" };
};

const isShapedByLoad = (data: unknown): boolean =>
  isRecord(data) &&
  ((isRecord(data["paginationOutcome"]) &&
    data["paginationOutcome"]["reason"] === "time_budget") ||
    (Array.isArray(data["warnings"]) &&
      data["warnings"].some(
        (warning) =>
          isRecord(warning) && warning["code"] === "partial_matches_unread",
      )));

/** Every continuable tool answers an object; anything else is a stale store. */
const isToolResponse = <TData>(
  value: unknown,
): value is InternalToolResult<TData> =>
  isRecord(value) &&
  ((value["status"] === "success" && isRecord(value["data"])) ||
    (value["status"] === "error" && isRecord(value["error"])));

/**
 * JSON storage drops the marker, and logs and analytics read a refusal without
 * it. Only this module writes the store, so the code can be trusted here.
 */
const restoreInternalFailure = <TData>(
  response: InternalToolResult<TData>,
): InternalToolResult<TData> =>
  response.status === "error" &&
  response.error.type === "structured" &&
  response.error.code === "internal_error"
    ? {
        ...response,
        error: { ...response.error, [MCP_INTERNAL_TOOL_FAILURE]: true },
      }
    : response;

/** A receipt names the request that hands it over, not the one that ran. */
const withCollectingRequestId = <TData>(
  response: InternalToolResult<TData>,
): InternalToolResult<TData> => {
  const requestId = getRequestId();
  return response.status === "error" &&
    response.error.type === "structured" &&
    requestId !== undefined
    ? { ...response, error: { ...response.error, requestId } }
    : response;
};

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
    result: (value) =>
      isToolResponse<TData>(value) ? restoreInternalFailure(value) : null,
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
    message: "This search did not finish after repeated attempts",
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

type UnderFleetCallerSlotOptions<T> = {
  context: Parameters<typeof withMcpPublicReadAdmission>[0]["caller"] &
    Pick<McpRequestContext, "testDependencies">;
  signal: AbortSignal;
  run: (signal: AbortSignal) => Promise<Result<T, unknown>>;
};

/**
 * Hold the caller's fleet-wide slot for the whole run. Work that has no request
 * waiting on it waits out a full pool instead of being refused; the run budget
 * ends the wait.
 */
const underFleetCallerSlot = async <T>({
  context,
  signal,
  run,
}: UnderFleetCallerSlotOptions<T>): Promise<Result<T, unknown>> => {
  const admit =
    context.testDependencies?.admitPublicRead ?? withMcpPublicReadAdmission;
  for (;;) {
    const admitted = await admit({ caller: context, signal, run });
    if (Result.isOk(admitted)) {
      return admitted.value.value;
    }
    if (
      !ActionAdmissionError.is(admitted.error) ||
      admitted.error.reason !== "busy" ||
      signal.aborted
    ) {
      return Result.err(admitted.error);
    }
    await sleep(FLEET_SLOT_RETRY_MS);
  }
};

type ContinuedWorkOptions<TArgs, TData, P> = {
  toolName: ContinuableToolName;
  workId: string;
  caller: string;
  scope: string;
  args: TArgs;
  context: UnderFleetCallerSlotOptions<unknown>["context"];
  execute: RunContinuablePublicReadOptions<TArgs, TData, P>["execute"];
};

const continuedWork = <TArgs, TData, P>({
  toolName,
  workId,
  caller,
  scope,
  args,
  context,
  execute,
}: ContinuedWorkOptions<TArgs, TData, P>): ContinuationWork<
  TArgs,
  InternalToolResult<TData>,
  P
> => {
  const statementBudgetMs = PUBLIC_READ_STATEMENT_TIMEOUT_MS.search;
  return {
    workId,
    caller,
    scope,
    args,
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
                        await underFleetCallerSlot({
                          context,
                          signal: run.signal,
                          run: async (signal) =>
                            await runWithPublicReadScope(
                              { budgetMs: statementBudgetMs, signal },
                              async () => await execute(runArgs, run),
                            ),
                        }),
                    );
                    return read;
                  }),
              ),
          ),
      ),
  };
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
    } else if (continuationToken === callerWorkId) {
      // The token is these arguments' own work: no spec is needed to honour it.
      via = "token";
    } else {
      return continuationExpiredResult(toolName);
    }
  }
  const caller = mcpPublicReadCallerKey(context);
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
    work: continuedWork({
      toolName,
      workId: continuationToken ?? callerWorkId,
      caller,
      scope,
      args: workArgs,
      context,
      execute,
    }),
  });
  switch (outcome.status) {
    case "finished":
      return await finish(withCollectingRequestId(outcome.result));
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

type WaitForPublicReadOptions<TArgs, TData> = {
  toolName: ContinuableToolName;
  continuation: ToolContinuation<TArgs, TData, null>;
  args: TArgs;
  context: RunContinuablePublicReadOptions<TArgs, TData, null>["context"];
  waitMs: number;
  execute: (args: TArgs) => Promise<InternalToolResult<TData>>;
  now?: () => number;
};

export type WaitedPublicRead<TData> =
  | { type: "finished"; result: InternalToolResult<TData> }
  | { type: "still_running" };

/**
 * The same continued read for a tool whose result has no way to say "still
 * running": it waits on the server, up to `waitMs`, and its caller decides
 * what to answer if the read has not finished by then.
 */
export const waitForPublicRead = async <TArgs, TData>({
  toolName,
  continuation,
  args,
  context,
  waitMs,
  execute,
  now = () => performance.now(),
}: WaitForPublicReadOptions<TArgs, TData>): Promise<
  WaitedPublicRead<TData>
> => {
  const scope = context.organizationId;
  const work = continuedWork<TArgs, TData, null>({
    toolName,
    workId: continuationWorkId(toolName, scope, args),
    caller: mcpPublicReadCallerKey(context),
    scope,
    args,
    context,
    execute: async (workArgs) => await execute(workArgs),
  });
  const waitLimitMs = Math.min(
    context.testDependencies?.publicReadResponseDeadlineMs ?? waitMs,
    Math.max(
      0,
      (remainingRequestBudgetMs() ?? Number.POSITIVE_INFINITY) -
        RESPONSE_RESERVE_MS,
    ),
  );
  const startedAt = now();
  for (;;) {
    const remainingMs = waitLimitMs - (now() - startedAt);
    const outcome = await continuation.attach({
      via: "call",
      responseDeadlineMs: Math.max(0, remainingMs),
      work,
    });
    switch (outcome.status) {
      case "finished":
        return { type: "finished", result: outcome.result };
      case "exhausted":
        return {
          type: "finished",
          result: publicReadUnfinishedResult(toolName),
        };
      case "failed":
        return { type: "finished", result: failedReadResult(outcome.error) };
      case "running": {
        // Measured again: the attach above can spend all of the wait.
        const leftMs = waitLimitMs - (now() - startedAt);
        if (leftMs <= 0) {
          return { type: "still_running" };
        }
        await sleep(Math.min(outcome.retryAfterMs, leftMs));
        break;
      }
      default:
        outcome satisfies never;
        return panic("Unhandled continuation outcome");
    }
  }
};
