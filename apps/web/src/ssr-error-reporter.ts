import { Result } from "better-result";

type SsrErrorReporterOptions = {
  captureError: (error: unknown) => void;
  writeDiagnostic: (line: string) => void;
};

export const createSsrErrorReporter = ({
  captureError,
  writeDiagnostic,
}: SsrErrorReporterOptions) => {
  const diagnostic = (message: string, error: unknown) =>
    writeDiagnostic(
      `${JSON.stringify({
        severity: "ERROR",
        message,
        // Renderer messages and request URLs can contain reader data.
        error: error instanceof Error ? error.name : "UnknownError",
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
