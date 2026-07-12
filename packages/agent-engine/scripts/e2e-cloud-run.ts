/**
 * End-to-end proof for the cloud agent engine (plan 050). Spins the codex
 * harness up inside a Docker sandbox via the real engine wiring and asserts
 * its output streams back as chat chunks.
 *
 * This is a manual script, not a unit test: it needs a running Docker daemon,
 * the sandbox image, and a real model credential, so it must never run in the
 * normal offline suite. Provide the credential OUT OF BAND — do not paste it
 * into a shell that logs history:
 *
 *   1. docker build -f packages/agent-engine/docker/sandbox.Dockerfile \
 *        -t stella/agent-sandbox:dev packages/agent-engine/docker
 *   2. echo "OPENAI_API_KEY=sk-..." > packages/agent-engine/.env.e2e   # gitignored
 *   3. bun run --filter @stll/agent-engine e2e:cloud
 *
 * The credential here is the harness's own model key (OpenAI/codex). It is NOT
 * a stella org key and NOT a user subscription — those never enter a sandbox.
 *
 * NOTE: the `e2e:cloud` script bundles this to a Node target and runs it under
 * Node, not bun. dockerode's container attach uses an HTTP 101 socket hijack
 * that docker-modem mishandles under bun; Node drives it correctly. This is
 * also why the production cloud engine must provision sandboxes from a Node
 * context, not directly in the bun api process (see plan 050).
 */
import { chat, EventType } from "@tanstack/ai";

import { resolveStellaSandboxRun, type HarnessProvider } from "../src/run";
import { SANDBOX_NO_MCP } from "../src/sandbox";

const IMAGE = process.env["AGENT_SANDBOX_IMAGE"] ?? "stella/agent-sandbox:dev";
const HARNESS_MODEL = process.env["AGENT_SANDBOX_MODEL"] ?? "gpt-4o-mini";

// Auto-detect the harness credential. codex speaks the OpenAI Responses API,
// so a plain OpenAI key is the default; `AGENT_HARNESS_BASE_URL` switches to a
// self-declared Responses-compatible gateway (the org's BYOK in production).
const apiKey = process.env["OPENAI_API_KEY"] ?? process.env["CODEX_API_KEY"];
const baseUrl = process.env["AGENT_HARNESS_BASE_URL"];
const provider: HarnessProvider = baseUrl ? "openai-compatible" : "openai";

if (!apiKey) {
  console.error(
    "e2e-cloud-run: set OPENAI_API_KEY (or CODEX_API_KEY) — the harness model credential — before running.",
  );
  process.exit(2);
}

const { adapter, middleware } = resolveStellaSandboxRun({
  runId: "e2e-cloud-run",
  engine: "cloud",
  harness: "codex",
  harnessProvider: provider,
  harnessModel: HARNESS_MODEL,
  harnessApiKey: apiKey,
  ...(baseUrl ? { harnessBaseUrl: baseUrl } : {}),
  cloudImage: IMAGE,
  // Smoke test: prove the harness boots in the sandbox and streams back, not
  // tool round-trips. Explicitly opt out of the MCP tool surface.
  mcp: SANDBOX_NO_MCP,
  instructions:
    "This is a connectivity smoke test. Do not call any tools. Reply with exactly the single word READY.",
});

console.log(`e2e-cloud-run: launching codex in ${IMAGE} …`);

const stream = chat({
  adapter,
  messages: [{ role: "user", content: "Say READY." }],
  threadId: "e2e-cloud-run",
  middleware: [middleware],
});

let text = "";
for await (const chunk of stream) {
  if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
    text += chunk.delta;
    process.stdout.write(chunk.delta);
  }
}

process.stdout.write("\n");
if (text.trim().length === 0) {
  console.error(
    "e2e-cloud-run: FAILED — no text streamed back from the harness.",
  );
  process.exit(1);
}
console.log(
  "e2e-cloud-run: OK — harness ran in the sandbox and streamed output.",
);
