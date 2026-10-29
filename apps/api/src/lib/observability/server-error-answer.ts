/**
 * The owner of every 5xx answer a handler or stage builds itself. A server
 * error answer is built only from its cause: the cause is observed on the
 * request in flight first, so its record carries the request id and the
 * completion record grades the answer by it rather than as an unobserved 5xx.
 *
 * The other owners answer their own 5xx: the safe handler boundary
 * (`api-handlers.ts`) for a `HandlerError` a handler returns, and the error
 * boundary (`request-lifecycle.ts`) for whatever the pipeline throws. A census
 * (`server-error-answer.census.test.ts`) keeps every other construction out.
 *
 * A computed status is answered here as well: a 5xx is observed, anything
 * else is answered as it is, without a record.
 */

import type { HttpStatusResponse } from "@/api/http/status";
import { status } from "@/api/http/status";
import type { FailureSink } from "@/api/lib/observability/failure";
import type { FailureContext } from "@/api/lib/observability/observe-failure";
import { observeAnswerFailure } from "@/api/lib/observability/observe-failure";

/** What an answer reports: the failure it was chosen from, and its sink. */
export type AnswerCause = {
  readonly sink: FailureSink;
  readonly cause: unknown;
  readonly ctx?: FailureContext | undefined;
};

export const isServerErrorStatus = (code: number): boolean =>
  code >= 500 && code <= 599;

/**
 * Observe the cause of an answer at `code` when it is a 5xx. For an answer
 * type that carries fields of its own (a `Response` subclass): it takes the
 * cause in its constructor and calls this there. Anything else answers
 * through {@link observedStatus} or {@link observedResponse}.
 */
export const observeServerError = (code: number, answer: AnswerCause): void => {
  if (isServerErrorStatus(code)) {
    observeAnswerFailure(answer.cause, { sink: answer.sink, ctx: answer.ctx });
  }
};

/** A handler answer at `code`; a 5xx is observed from its cause first. */
export const observedStatus = <const TCode extends number, const TBody>(
  answer: AnswerCause,
  code: TCode,
  body: TBody,
): HttpStatusResponse<TCode, TBody> => {
  observeServerError(code, answer);
  return status(code, body);
};

/** A raw `Response` at `init.status`; a 5xx is observed from its cause first. */
export const observedResponse = (
  answer: AnswerCause,
  body: ConstructorParameters<typeof Response>[0],
  init: ResponseInit & { readonly status: number },
): Response => {
  observeServerError(init.status, answer);
  return new Response(body, init);
};

/** Rebuild an existing transport response while preserving its chosen status. */
export const rebuildResponse = (
  response: Response,
  body: ConstructorParameters<typeof Response>[0],
): Response =>
  new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
