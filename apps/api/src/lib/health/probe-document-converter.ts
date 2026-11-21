import { fetchWithTimeout } from "@stll/fetch";

import { env } from "@/api/env";
import { basicAuthorizationHeader } from "@/api/lib/auth/http-basic-auth";
import { HealthCheckError } from "@/api/lib/errors/tagged-errors";

export const probeDocumentConverter = async (
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> => {
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
