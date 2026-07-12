import { codexText } from "@tanstack/ai-codex";
import { withSandbox } from "@tanstack/ai-sandbox";
import { panic } from "better-result";

import {
  defineStellaSandbox,
  type AgentHarness,
  type StellaSandboxInput,
} from "./sandbox";

/**
 * Everything a sandbox chat run needs on top of the plain chat inputs. The
 * harness model id and its API key are the harness's own model credential
 * (e.g. an OpenAI key for codex) — NOT a stella org key and NOT a user
 * subscription; those never enter the sandbox. Stella workspace access is
 * solely via the bridged MCP server described in `sandbox.mcp`.
 */
export type StellaSandboxRunInput = StellaSandboxInput & {
  harness: AgentHarness;
  harnessModel: string;
  harnessApiKey: string;
};

/**
 * Resolve a sandbox run to the `adapter` and `middleware` a `chat()` call
 * must use. The harness adapter declares it `requires` a sandbox capability,
 * and `withSandbox()` provides it, so these two must travel together — that
 * coupling is the reason this returns both rather than letting the caller
 * assemble them. Only codex is wired today; other harnesses throw until their
 * adapters and approvals land (plan 050).
 */
export const resolveStellaSandboxRun = (input: StellaSandboxRunInput) => {
  if (input.harness !== "codex") {
    panic(
      `resolveStellaSandboxRun: harness "${input.harness}" is not wired yet`,
    );
  }

  const adapter = codexText(input.harnessModel, {
    // The outer TanStack/Docker sandbox is the real isolation boundary; codex
    // may write within its workspace. Never auto-approve unknown commands —
    // the stella sandbox policy is the gate.
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    env: { CODEX_API_KEY: input.harnessApiKey },
  });

  const middleware = withSandbox(defineStellaSandbox(input));

  return { adapter, middleware };
};
