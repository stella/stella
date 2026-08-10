import { env } from "@/api/env";
import { HealthCheckError } from "@/api/lib/errors/tagged-errors";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { basicAuthorizationHeader } from "@/api/lib/http-basic-auth";

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
