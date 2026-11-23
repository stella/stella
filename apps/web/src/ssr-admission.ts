import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { isAnonymousRequest } from "./anonymous-request";

/**
 * Bounded admission for the requests the web runtime hands to the server
 * renderer.
 *
 * Every admitted request holds memory until its response body has been sent:
 * route data, the rendered document and its dehydrated state. Without a bound,
 * a burst of document requests is buffered until the task runs out of memory
 * and every viewer loses the page. With one, a request over the limit is
 * answered at once with 503 and Retry-After, and the admitted ones finish.
 *
 * Health checks and static files are answered by the runtime before the
 * renderer and never reach this gate.
 */

export const SSR_MAX_IN_FLIGHT_ENV = "STELLA_WEB_SSR_MAX_IN_FLIGHT";

/**
 * Sized for a 512 MB to 1 GB web task: the runtime itself takes about a
 * quarter of that, and a large public document (a long statute with its
 * dehydrated data) can hold tens of megabytes while it renders.
 */
export const DEFAULT_SSR_MAX_IN_FLIGHT = 24;

const MIN_SSR_MAX_IN_FLIGHT = 2;
const MAX_SSR_MAX_IN_FLIGHT = 1024;

/**
 * Requests without credentials may hold at most this share of the slots, so a
 * burst of anonymous traffic always leaves room for signed-in viewers.
 */
const ANONYMOUS_SHARE = 0.75;

export const SSR_SHED_RETRY_AFTER_SECONDS = 5;

export type SsrAdmissionLimits = {
  /** Requests rendering at once, across every viewer. */
  total: number;
  /** Of those, requests that carry no credentials. */
  anonymous: number;
};

export class SsrAdmissionConfigError extends TaggedError(
  "SsrAdmissionConfigError",
)<{
  message: string;
}> {}

const maxInFlightSchema = v.optional(
  v.pipe(
    v.string(),
    v.trim(),
    v.digits(),
    v.toNumber(),
    v.integer(),
    v.minValue(MIN_SSR_MAX_IN_FLIGHT),
    v.maxValue(MAX_SSR_MAX_IN_FLIGHT),
  ),
  String(DEFAULT_SSR_MAX_IN_FLIGHT),
);

export const ssrAdmissionLimitsFor = (total: number): SsrAdmissionLimits => ({
  total,
  anonymous: Math.max(1, Math.floor(total * ANONYMOUS_SHARE)),
});

/** Reads the limit from the runtime environment; unset or empty uses the default. */
export const readSsrAdmissionLimits = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<SsrAdmissionLimits, SsrAdmissionConfigError> => {
  const raw = environment[SSR_MAX_IN_FLIGHT_ENV];
  const parsed = v.safeParse(maxInFlightSchema, raw === "" ? undefined : raw);
  if (!parsed.success) {
    return Result.err(
      new SsrAdmissionConfigError({
        message: `${SSR_MAX_IN_FLIGHT_ENV} must be a whole number from ${MIN_SSR_MAX_IN_FLIGHT} to ${MAX_SSR_MAX_IN_FLIGHT}.`,
      }),
    );
  }
  return Result.ok(ssrAdmissionLimitsFor(parsed.output));
};

type SsrPermit = { release: () => void };

export type SsrAdmission = {
  tryAdmit: (request: Request) => SsrPermit | null;
  inFlight: () => { total: number; anonymous: number };
  limits: SsrAdmissionLimits;
};

export const createSsrAdmission = (
  limits: SsrAdmissionLimits,
): SsrAdmission => {
  let total = 0;
  let anonymous = 0;
  return {
    limits,
    inFlight: () => ({ total, anonymous }),
    tryAdmit: (request) => {
      const isAnonymous = isAnonymousRequest(request);
      if (
        total >= limits.total ||
        (isAnonymous && anonymous >= limits.anonymous)
      ) {
        return null;
      }
      total += 1;
      if (isAnonymous) {
        anonymous += 1;
      }
      let released = false;
      return {
        release: () => {
          if (released) {
            return;
          }
          released = true;
          total -= 1;
          if (isAnonymous) {
            anonymous -= 1;
          }
        },
      };
    },
  };
};

export const shedSsrResponse = (): Response =>
  new Response("The server is busy. Please retry shortly.\n", {
    status: 503,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": String(SSR_SHED_RETRY_AFTER_SECONDS),
      "X-Robots-Tag": "noindex",
    },
  });

// The permit is held until the body has been sent, failed or been cancelled:
// a streamed document keeps its renderer alive until then.
const releaseAfterBody = (response: Response, release: () => void) => {
  if (response.body === null) {
    release();
    return response;
  }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  // The pipe settles when the source ends, when it fails (the viewer's body
  // fails with it) and when the viewer cancels (the source is cancelled).
  response.body
    .pipeTo(writable)
    .then(release)
    .catch((_pipeError: unknown) => {
      release();
    });
  return new Response(readable, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};

type FetchHandler = {
  fetch: (request: Request) => Response | Promise<Response>;
};

export const isFetchHandler = (candidate: unknown): candidate is FetchHandler =>
  typeof candidate === "object" &&
  candidate !== null &&
  "fetch" in candidate &&
  typeof candidate.fetch === "function";

type WithSsrAdmissionOptions = {
  admission: SsrAdmission;
  handler: FetchHandler;
  onShed?: ((admission: SsrAdmission) => void) | undefined;
};

export const withSsrAdmission = ({
  admission,
  handler,
  onShed,
}: WithSsrAdmissionOptions): {
  fetch: (request: Request) => Promise<Response>;
} => ({
  async fetch(request) {
    const permit = admission.tryAdmit(request);
    if (permit === null) {
      onShed?.(admission);
      return shedSsrResponse();
    }
    const release = () => {
      request.signal.removeEventListener("abort", release);
      permit.release();
    };
    // A viewer that disconnects frees its slot; the renderer observes the
    // same signal and stops.
    request.signal.addEventListener("abort", release, { once: true });
    if (request.signal.aborted) {
      release();
    }
    const pending = Promise.resolve().then(
      async () => await handler.fetch(request),
    );
    // A rejected render frees its slot; awaiting it below still hands the
    // rejection to the server, which answers 500.
    pending.catch((_renderError: unknown) => {
      release();
    });
    return releaseAfterBody(await pending, release);
  },
});

type ShedReporterOptions = {
  intervalMs: number;
  now: () => number;
  writeDiagnostic: (line: string) => void;
};

/**
 * Writes at most one line per interval while requests are being shed, with
 * the count since the previous line, so an overload cannot flood the log.
 */
export const createSsrShedReporter = ({
  intervalMs,
  now,
  writeDiagnostic,
}: ShedReporterOptions) => {
  let shed = 0;
  let lastWrittenAt = Number.NEGATIVE_INFINITY;
  return (admission: SsrAdmission) => {
    shed += 1;
    const at = now();
    if (at - lastWrittenAt < intervalMs) {
      return;
    }
    lastWrittenAt = at;
    const inFlight = admission.inFlight();
    writeDiagnostic(
      `${JSON.stringify({
        severity: "WARNING",
        message: "ssr.admission_shed",
        shed,
        inFlight: inFlight.total,
        anonymousInFlight: inFlight.anonymous,
        limit: admission.limits.total,
        anonymousLimit: admission.limits.anonymous,
      })}\n`,
    );
    shed = 0;
  };
};
