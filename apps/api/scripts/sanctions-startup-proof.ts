import { Result, TaggedError } from "better-result";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class SanctionsStartupProofError extends TaggedError(
  "SanctionsStartupProofError",
)<{ message: string }> {}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export const proveSanctionsStartup = async ({
  baseUrl,
  fetch: request = async (input, { signal, ...init } = {}) =>
    await fetchWithTimeout(input, {
      ...init,
      signal: signal ?? undefined,
      timeout: { type: "headers", ms: POLL_TIMEOUT_MS },
    }),
  sleep = Bun.sleep,
  now = Date.now,
  pollIntervalMs = POLL_INTERVAL_MS,
  pollTimeoutMs = POLL_TIMEOUT_MS,
}: {
  baseUrl: string;
  fetch?: Fetch;
  sleep?: (durationMs: number) => Promise<unknown>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}): Promise<void> => {
  const startedAt = now();
  const remaining = () => pollTimeoutMs - (now() - startedAt);
  const requestBeforeDeadline = async (
    url: URL,
    init?: RequestInit,
  ): Promise<Result<Response, unknown>> =>
    await Result.tryPromise({
      try: async () =>
        await request(url, {
          ...init,
          signal: AbortSignal.timeout(Math.max(1, remaining())),
        }),
      catch: (cause) => cause,
    });
  for (;;) {
    const response = await requestBeforeDeadline(new URL("/started", baseUrl));
    if (Result.isOk(response) && response.value.ok) {
      break;
    }
    if (remaining() <= 0) {
      throw new SanctionsStartupProofError({
        message: "The API did not report started before the proof timeout",
      });
    }
    await sleep(Math.min(pollIntervalMs, remaining()));
  }

  const response = await requestBeforeDeadline(
    new URL(`${STELLA_API_VERSION_PREFIX}/sanctions/search`, baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: { type: "organization", name: "Startup proof" },
      }),
    },
  );
  if (Result.isError(response)) {
    throw new SanctionsStartupProofError({
      message: "Sanctions search request failed",
    });
  }
  if (!response.value.ok) {
    throw new SanctionsStartupProofError({
      message: `Sanctions search failed with HTTP ${response.value.status}`,
    });
  }
  const body: unknown = await response.value.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("lists" in body) ||
    !Array.isArray(body.lists)
  ) {
    throw new SanctionsStartupProofError({
      message: "Sanctions search returned an invalid response",
    });
  }
  const warming = body.lists.filter(
    (list): list is { source?: unknown; reason: "warming" } =>
      typeof list === "object" &&
      list !== null &&
      "reason" in list &&
      list.reason === "warming",
  );
  if (warming.length > 0) {
    throw new SanctionsStartupProofError({
      message: "Sanctions search reported warming after /started",
    });
  }
};

if (import.meta.main) {
  const baseUrl = Bun.argv.at(2);
  if (baseUrl === undefined) {
    throw new SanctionsStartupProofError({
      message: "Usage: bun scripts/sanctions-startup-proof.ts <base-url>",
    });
  }
  await proveSanctionsStartup({ baseUrl });
}
