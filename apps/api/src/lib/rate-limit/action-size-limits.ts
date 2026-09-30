import { panic, Result, TaggedError } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { env } from "@/api/env";
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
}> {}

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

// Meter actual bytes even when Content-Length is present. Retain at most the
// allowed body and stop reading immediately when a chunk crosses the bound.
export const boundActionRequest = async (
  request: Request,
  maximum: number,
): Promise<Result<Request, ActionSizeError>> => {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
    return Result.err(requestTooLarge());
  }
  if (request.body === null) {
    return Result.ok(request);
  }
  // Meter a tee while retaining Bun's original socket-bound Request.
  const metered = request.clone();
  const stream: ReadableStream<Uint8Array> | null = metered.body;
  if (stream === null) {
    return panic("Cloned action request lost its body");
  }
  let size = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        request.headers.set("content-length", String(size));
        return Result.ok(request);
      }
      size += chunk.value.byteLength;
      if (size <= maximum) {
        continue;
      }
      // Both tee branches must cancel together; either alone waits for its peer.
      await Promise.all([reader.cancel(), request.body.cancel()]);
      return Result.err(requestTooLarge());
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
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
