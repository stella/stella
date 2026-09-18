import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_MODELS } from "@stll/ai-catalog";

import { createCassetteFetch } from "./ai-provider-cassette";

// This entry point records only this synthetic probe, never application traffic.
// Keep it isolated in its own process: replacing fetch is not safe in a shared
// test worker, and SDK clients must be constructed after the replacement.
const run = async () => {
  const [mode, file, ...extra] = Bun.argv.slice(2);
  if ((mode !== "record" && mode !== "replay") || !file || extra.length > 0) {
    throw new TypeError(
      "Usage: ai-provider-cassette-probe.ts record|replay <file>",
    );
  }

  const cassettePath = path.resolve(file);
  if (mode === "record" && (await Bun.file(cassettePath).exists())) {
    throw new TypeError(
      "Recording destination already exists; choose a new file for review.",
    );
  }
  const apiKey =
    mode === "record"
      ? process.env["AI_CANARY_API_KEY"] || process.env["OPENROUTER_API_KEY"]
      : "cassette-replay-no-credentials";
  if (!apiKey) {
    throw new TypeError(
      "Recording requires AI_CANARY_API_KEY or OPENROUTER_API_KEY.",
    );
  }

  const transport =
    mode === "record"
      ? createCassetteFetch({
          apiKey,
          maxRequests: 1,
          mode,
          permittedOrigins: ["https://openrouter.ai"],
          upstreamFetch: globalThis.fetch,
        })
      : createCassetteFetch({
          mode,
          cassette: await Bun.file(cassettePath).json(),
        });

  globalThis.fetch = Object.assign(transport.fetch, {
    preconnect: () => {
      throw new TypeError("Preconnect is unavailable in cassette probes.");
    },
  });
  const { generateTanStackTextForRole } =
    await import("@/api/lib/tanstack-ai-generate");
  const selection = {
    modelId: DEFAULT_MODELS.openrouter.fast,
    provider: "openrouter",
  } as const;
  const output = await generateTanStackTextForRole({
    abortSignal: AbortSignal.timeout(30_000),
    caching: { enabled: false, reason: "org-disabled" },
    finishPolicy: "require-complete",
    maxOutputTokens: 32,
    organizationId: null,
    orgAIConfig: {
      overrideModels: {
        fast: selection,
        chat: selection,
        reasoning: selection,
        pdf: selection,
      },
      providers: [{ provider: "openrouter", apiKey }],
      decision: null,
    },
    prompt: "Reply with exactly OK.",
    role: "fast",
    serviceTier: "standard",
    tenantWorkspaceIds: [],
  });
  const cassette = await transport.finish();
  if (output.trim() !== "OK" || cassette.entries.length !== 1) {
    throw new TypeError(
      "Synthetic cassette probe did not produce the expected single response.",
    );
  }
  if (mode === "record") {
    await mkdir(path.dirname(cassettePath), { recursive: true });
    await writeFile(cassettePath, `${JSON.stringify(cassette, null, 2)}\n`, {
      flag: "wx",
    });
  }
  console.log(
    `AI cassette ${mode}: passed (1 request, synthetic OK response).`,
  );
};

if (import.meta.main) {
  await run().catch(() => {
    // Provider and parser errors can echo credentials or response bodies.
    console.error(
      "AI cassette probe failed. Check the mode, fixture, credentials, and request contract.",
    );
    process.exitCode = 1;
  });
}
