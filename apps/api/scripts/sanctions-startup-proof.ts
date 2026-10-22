import { TaggedError } from "better-result";

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
  fetch: request = fetch,
  sleep = Bun.sleep,
  now = Date.now,
}: {
  baseUrl: string;
  fetch?: Fetch;
  sleep?: (durationMs: number) => Promise<unknown>;
  now?: () => number;
}): Promise<void> => {
  const startedAt = now();
  for (;;) {
    const response = await request(new URL("/started", baseUrl));
    if (response.ok) {
      break;
    }
    if (now() - startedAt >= POLL_TIMEOUT_MS) {
      throw new SanctionsStartupProofError({
        message: "The API did not report started before the proof timeout",
      });
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const response = await request(new URL("/sanctions/search", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subject: { type: "organization", name: "Startup proof" },
    }),
  });
  if (!response.ok) {
    throw new SanctionsStartupProofError({
      message: `Sanctions search failed with HTTP ${response.status}`,
    });
  }
  const body: unknown = await response.json();
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
