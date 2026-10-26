import { Result, TaggedError } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { declareFingerprintFields } from "@stll/errors";

import { env } from "@/api/env";
import { reframeBoundedRequest } from "@/api/http/request-body";
import type { BoundedRequest } from "@/api/http/request-body";
import { logger } from "@/api/lib/observability/logger";
import { emitActionResponseOversizeMetric } from "@/api/lib/observability/request-metrics";

export type ActionSizePolicy = {
  requestBytes: number;
  responseBytes: number;
  pageSize: number;
};

export class ActionSizeError extends TaggedError("ActionSizeError")<{
  message: string;
  reason: "configuration" | "request_too_large" | "response_too_large";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type ActionSizeConfiguration = Pick<
  typeof env,
  | "FEATURE_ACTION_ADMISSION"
  | "ACTION_REQUEST_MAX_BYTES"
  | "ACTION_RESPONSE_MAX_BYTES"
  | "ACTION_PAGE_SIZE_MAX"
>;

export const getActionSizePolicy = (
  configuration: ActionSizeConfiguration = env,
): Result<ActionSizePolicy | undefined, ActionSizeError> => {
  if (!configuration.FEATURE_ACTION_ADMISSION) {
    return Result.ok(undefined);
  }
  const requestBytes = configuration.ACTION_REQUEST_MAX_BYTES;
  const responseBytes = configuration.ACTION_RESPONSE_MAX_BYTES;
  const pageSize = configuration.ACTION_PAGE_SIZE_MAX;
  if (
    requestBytes === undefined ||
    responseBytes === undefined ||
    pageSize === undefined
  ) {
    return Result.err(
      new ActionSizeError({
        message: "Action size limits are not configured",
        reason: "configuration",
      }),
    );
  }
  return Result.ok({ requestBytes, responseBytes, pageSize });
};

const tenantPolicy = new AsyncLocalStorage<ActionSizePolicy>();

export const getTenantActionSizePolicy = (): ActionSizePolicy | undefined =>
  tenantPolicy.getStore();

// Only authenticated action dispatch opens this scope. Anonymous reads and
// background scans keep their own bounds, even when the feature is enabled.
export const withTenantActionSizePolicy = <T>(
  policy: ActionSizePolicy | undefined,
  run: () => T,
): T => (policy === undefined ? run() : tenantPolicy.run(policy, run));

export const normalizeTenantPageLimit = (resolvedLimit: number): number => {
  const policy = tenantPolicy.getStore();
  return policy === undefined
    ? resolvedLimit
    : Math.min(resolvedLimit, policy.pageSize);
};

const requestTooLarge = () =>
  new ActionSizeError({
    message: "Request body exceeds the configured byte limit",
    reason: "request_too_large",
  });

// A reframed request carries its metered size, so nested admission
// boundaries (multipart, then the tenant action) never read a body twice.
const reframedBytes = new WeakMap<Request, number>();

/**
 * Meters and re-frames a tenant action's request body against the action
 * size policy; an oversized body is refused as `request_too_large`.
 */
export const boundActionRequest = async (
  request: Request,
  maximum: number,
): Promise<Result<BoundedRequest, ActionSizeError>> => {
  const measured = reframedBytes.get(request);
  if (measured !== undefined) {
    return measured <= maximum
      ? Result.ok({ request, bytes: measured })
      : Result.err(requestTooLarge());
  }
  const bounded = (await reframeBoundedRequest(request, maximum)).mapError(() =>
    requestTooLarge(),
  );
  if (Result.isOk(bounded)) {
    reframedBytes.set(bounded.value.request, bounded.value.bytes);
  }
  return bounded;
};

export const actionSizeErrorResponse = (
  error: ActionSizeError,
  maximum?: number,
): Response => {
  const status = error.reason === "configuration" ? 503 : 413;
  const serialized = JSON.stringify({
    code:
      error.reason === "configuration" ? "service_unavailable" : error.reason,
    message: error.message,
  });
  // Even a refusal must fit the emission bound. With no room for the error
  // envelope, the status alone communicates the refusal; no bytes are cut.
  const body =
    maximum !== undefined && Buffer.byteLength(serialized, "utf-8") > maximum
      ? null
      : serialized;
  return new Response(body, {
    status,
    headers: body === null ? {} : { "content-type": "application/json" },
  });
};

type ActionResponseOversizeOptions = {
  transport: "http" | "mcp";
  operation: string;
  bytes: number;
  maximum: number;
};

export const recordActionResponseOversize = (
  options: ActionResponseOversizeOptions,
): void => {
  logger.warn("action.response_oversize", options);
  emitActionResponseOversizeMetric(options.transport);
};

type ActionJsonResponseOptions = {
  maximum: number;
  disposition: "refuse" | "preserve_success";
  operation: string;
};

// This boundary consumes only finite JSON bodies, including their transport
// envelopes. SSE, downloads and other streaming media keep their own owners.
export const boundActionJsonResponse = async (
  response: Response,
  { maximum, disposition, operation }: ActionJsonResponseOptions,
): Promise<Response> => {
  if (
    response.body === null ||
    !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/iu.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    return response;
  }
  const effectiveDisposition = response.ok ? disposition : "refuse";
  const stream: ReadableStream<Uint8Array> = response.body;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maximum && effectiveDisposition === "refuse") {
      const refused = actionSizeErrorResponse(
        new ActionSizeError({
          message:
            "Response exceeds the configured byte limit; request a smaller selection",
          reason: "response_too_large",
        }),
        maximum,
      );
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.delete("etag");
      headers.delete("content-disposition");
      return new Response(refused.body, { status: refused.status, headers });
    }
    chunks.push(chunk);
  }
  if (size > maximum) {
    recordActionResponseOversize({
      transport: "http",
      operation,
      bytes: size,
      maximum,
    });
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
