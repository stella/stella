import { fetchWithTimeout } from "@stll/fetch";

import { env } from "@/api/env";
import { HealthCheckError } from "@/api/lib/errors/tagged-errors";
import { basicAuthorizationHeader } from "@/api/lib/http-basic-auth";

export const probeDocumentConverter = async (
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> => {
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- operator-configured Gotenberg deployment from validated env; no request data selects the origin
  const response = await fetchWithTimeout(`${env.GOTENBERG_URL}/health`, {
    headers: {
      Authorization: basicAuthorizationHeader(
        env.GOTENBERG_USERNAME,
        env.GOTENBERG_PASSWORD,
      ),
    },
    signal,
    timeoutMs,
  });
  if (!response.ok) {
    throw new HealthCheckError({
      message: "Document converter health probe failed",
    });
  }
};
