import { Result } from "better-result";

import { APIError } from "@/lib/errors/api";

type SsrErrorReporterOptions = {
  captureError: (error: unknown) => void;
  writeDiagnostic: (line: string) => void;
};

// Renderer messages and request URLs can contain reader data, so a diagnostic
// names the error's class and never its message.
const errorClass = (error: unknown): string =>
  error instanceof Error ? error.name : "UnknownError";

export const createSsrErrorReporter = ({
  captureError,
  writeDiagnostic,
}: SsrErrorReporterOptions) => {
  const diagnostic = (message: string, error: unknown) =>
    writeDiagnostic(
      `${JSON.stringify({
        severity: "ERROR",
        message,
        error: errorClass(error),
      })}\n`,
    );
  return (error: unknown) => {
    diagnostic("ssr.response_failed", error);
    const captured = Result.try({
      try: () => captureError(error),
      catch: (cause) => cause,
    });
    if (captured.isErr()) {
      diagnostic("ssr.telemetry_failed", captured.error);
    }
  };
};

const SERVER_ERROR_STATUS = 500;

type SsrRouteMatch = {
  readonly routeId: string;
  readonly status: string;
  readonly error?: unknown;
};

type SsrRouteFailure = {
  /** The matched route's template, never the requested path. */
  route: string;
  status: number;
  error: string;
  /** What the API read answered, when the failure is a refused API read. */
  upstreamStatus?: number;
  upstreamTransport?: string;
};

/**
 * Why a rendered document left with a server-error status, or null when it did
 * not. The router answers 500 for a page whose loader threw, rendering the
 * route's error component instead of failing the request, so no exception
 * reaches the response path and the failure is visible only here.
 */
export const describeSsrRouteFailure = ({
  matches,
  status,
}: {
  matches: readonly SsrRouteMatch[];
  status: number;
}): SsrRouteFailure | null => {
  if (status < SERVER_ERROR_STATUS) {
    return null;
  }
  const failed = matches.find((match) => match.status === "error");
  const error = failed?.error;
  return {
    route: failed?.routeId ?? matches.at(-1)?.routeId ?? "unknown",
    status,
    error: failed === undefined ? "UnknownError" : errorClass(error),
    ...(APIError.is(error) && {
      upstreamStatus: error.status,
      ...(error.transportKind !== undefined && {
        upstreamTransport: error.transportKind,
      }),
    }),
  };
};

/** Writes one structured line for each document that leaves with a 5xx. */
export const createSsrRouteFailureReporter =
  ({ writeDiagnostic }: Pick<SsrErrorReporterOptions, "writeDiagnostic">) =>
  (options: Parameters<typeof describeSsrRouteFailure>[0]) => {
    const failure = describeSsrRouteFailure(options);
    if (failure === null) {
      return;
    }
    writeDiagnostic(
      `${JSON.stringify({
        severity: "ERROR",
        message: "ssr.route_failed",
        ...failure,
      })}\n`,
    );
  };
