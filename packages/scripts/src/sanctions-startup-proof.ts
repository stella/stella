import { Result, TaggedError } from "better-result";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";
import { createFetchWithTimeout, fetchWithTimeout } from "@stll/fetch";
import type { Fetcher } from "@stll/fetch";

class SanctionsStartupProofError extends TaggedError(
  "SanctionsStartupProofError",
)<{ message: string }> {}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

type ScreenedList = { source: string; reason: string | null };

/**
 * One list outcome as the public search answers it. Anything else is not a
 * screening the proof can vouch for, so it fails rather than counting as warm.
 */
const isScreenedList = (value: unknown): value is ScreenedList =>
  typeof value === "object" &&
  value !== null &&
  "source" in value &&
  typeof value.source === "string" &&
  value.source.length > 0 &&
  "reason" in value &&
  (value.reason === null ||
    (typeof value.reason === "string" && value.reason.length > 0));

const screenedLists = (body: unknown): readonly ScreenedList[] | null => {
  if (
    typeof body !== "object" ||
    body === null ||
    !("lists" in body) ||
    !Array.isArray(body.lists)
  ) {
    return null;
  }
  const lists: unknown[] = body.lists;
  return lists.length > 0 && lists.every(isScreenedList) ? lists : null;
};

const proofError = (message: string) =>
  Result.err(new SanctionsStartupProofError({ message }));

export const proveSanctionsStartup = async ({
  baseUrl,
  transport,
  sleep = Bun.sleep,
  now = () => performance.now(),
  pollIntervalMs = POLL_INTERVAL_MS,
  pollTimeoutMs = POLL_TIMEOUT_MS,
}: {
  baseUrl: string;
  /** The transport under the timeout wrapper; the global fetch by default. */
  transport?: Fetcher;
  sleep?: (durationMs: number) => Promise<unknown>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}): Promise<Result<void, SanctionsStartupProofError>> => {
  const request =
    transport === undefined
      ? fetchWithTimeout
      : createFetchWithTimeout(transport);
  const startedAt = now();
  const remaining = () => pollTimeoutMs - (now() - startedAt);
  // The deadline signal reaches the body too: the idle wrapper errors the
  // stream it hands back when the signal aborts, whatever the transport does.
  const requestBeforeDeadline = async (url: URL, init?: RequestInit) =>
    await Result.tryPromise({
      try: async () =>
        await request(url, {
          ...init,
          signal: AbortSignal.timeout(Math.max(1, remaining())),
          timeout: { type: "idle", ms: pollTimeoutMs },
        }),
      catch: (cause) => cause,
    });
  for (;;) {
    const response = await requestBeforeDeadline(new URL("/started", baseUrl));
    if (Result.isOk(response) && response.value.ok) {
      break;
    }
    if (remaining() <= 0) {
      return proofError(
        "The API did not report started before the proof timeout",
      );
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
    return proofError("Sanctions search request failed");
  }
  if (!response.value.ok) {
    return proofError(
      `Sanctions search failed with HTTP ${response.value.status}`,
    );
  }
  const body = await Result.tryPromise({
    try: async (): Promise<unknown> => await response.value.json(),
    catch: (cause) => cause,
  });
  if (Result.isError(body)) {
    return proofError(
      "Sanctions search response did not arrive as JSON before the proof timeout",
    );
  }
  const lists = screenedLists(body.value);
  if (lists === null) {
    return proofError("Sanctions search returned an invalid response");
  }
  if (lists.some(({ reason }) => reason === "warming")) {
    return proofError("Sanctions search reported warming after /started");
  }
  return Result.ok();
};

if (import.meta.main) {
  const baseUrl = Bun.argv.at(2);
  const proof =
    baseUrl === undefined
      ? proofError(
          "Usage: bun packages/scripts/src/sanctions-startup-proof.ts <base-url>",
        )
      : await proveSanctionsStartup({ baseUrl });
  if (Result.isError(proof)) {
    console.error(proof.error.message);
    process.exitCode = 1;
  }
}
