import { codexText, type CodexTextConfig } from "@tanstack/ai-codex";
import { withSandbox } from "@tanstack/ai-sandbox";
import { panic } from "better-result";

import {
  defineStellaSandbox,
  SANDBOX_NO_MCP,
  STELLA_WORKSPACE_ROOT,
  type AgentHarness,
  type StellaSandboxInput,
} from "./sandbox";

/**
 * The provider backing the harness's model. codex speaks the OpenAI
 * *Responses* API only (it dropped chat-completions in recent versions), so a
 * provider is usable here only if it exposes a Responses-compatible endpoint:
 * `openai` (the hosted API) or `openai-compatible` (a self-declared Responses
 * base URL, e.g. an Azure/proxy gateway). Plain chat-completions gateways such
 * as OpenRouter are NOT usable with the codex harness today.
 */
export const HARNESS_PROVIDERS = ["openai", "openai-compatible"] as const;
export type HarnessProvider = (typeof HARNESS_PROVIDERS)[number];

/**
 * Everything a sandbox chat run needs on top of the plain chat inputs. The
 * harness model credential (e.g. an OpenAI key) is the harness's own — NOT a
 * stella org key and NOT a user subscription; those never enter the sandbox.
 * Stella workspace access is solely via the bridged MCP server in
 * `sandbox.mcp`.
 */
export type StellaSandboxRunInput = StellaSandboxInput & {
  harness: AgentHarness;
  harnessModel: string;
  harnessApiKey: string;
} & (
    | { harnessProvider: "openai" }
    | {
        harnessProvider: "openai-compatible";
        /** Responses-API base URL for the explicitly compatible gateway. */
        harnessBaseUrl: string;
      }
  );

const HARNESS_KEY_ENV = "STELLA_HARNESS_KEY";
const HARNESS_PROVIDER_ID = "stella";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const STELLA_CODEX_HOME = `${STELLA_WORKSPACE_ROOT}/.codex`;
const TRUSTED_MCP_TOOL_APPROVAL_MODE = '"approve"';

const harnessBaseUrl = (input: StellaSandboxRunInput): string => {
  if (input.harnessProvider === "openai") {
    return OPENAI_BASE_URL;
  }
  return input.harnessBaseUrl;
};

/**
 * Build the Codex boundary configuration in one place. TanStack projects MCP
 * bindings into `<workspace>/.codex/config.toml`; source-less Stella runs are
 * not trusted Git projects, so Codex deliberately ignores that file as project
 * configuration. For MCP runs, pointing CODEX_HOME at the projected directory
 * makes it the process's user configuration instead, which Codex loads without
 * weakening project-trust checks or placing the delegated MCP token on the
 * command line. No-MCP smoke runs retain the ambient home because TanStack does
 * not project this directory for them.
 */
export const buildCodexAdapterConfig = (input: StellaSandboxRunInput) => {
  const provider = HARNESS_PROVIDER_ID;
  return {
    // The outer TanStack/Docker sandbox is the real isolation boundary; codex
    // may write within its workspace. Shell-command approval remains governed
    // by the Stella sandbox policy: its `ask`/`deny` rules map to on-request,
    // so approval-requiring commands fail closed in non-interactive `codex
    // exec`. The trusted Stella MCP's tool approval is configured separately
    // below; it does not alter command approval or network controls.
    sandboxMode: "workspace-write",
    env: {
      ...(input.mcp === SANDBOX_NO_MCP
        ? {}
        : { CODEX_HOME: STELLA_CODEX_HOME }),
      [HARNESS_KEY_ENV]: input.harnessApiKey,
    },
    // Raw codex `-c` overrides (verbatim TOML values). Point codex at the
    // resolved provider via a custom model_provider reading the key from env.
    config: {
      model_provider: `"${provider}"`,
      [`model_providers.${provider}.name`]: `"stella-harness"`,
      [`model_providers.${provider}.base_url`]: `"${harnessBaseUrl(input)}"`,
      [`model_providers.${provider}.env_key`]: `"${HARNESS_KEY_ENV}"`,
      [`model_providers.${provider}.wire_api`]: `"responses"`,
      ...(input.mcp === SANDBOX_NO_MCP
        ? {}
        : {
            [`mcp_servers.${input.mcp.serverName}.default_tools_approval_mode`]:
              TRUSTED_MCP_TOOL_APPROVAL_MODE,
          }),
    },
  } as const satisfies CodexTextConfig;
};

/**
 * Resolve a sandbox run to the `adapter` and `middleware` a `chat()` call
 * must use. The harness adapter declares it `requires` a sandbox capability,
 * and `withSandbox()` provides it, so these two must travel together — that
 * coupling is the reason this returns both rather than letting the caller
 * assemble them. Unsupported harnesses fail closed.
 *
 * The model credential is injected into the codex process env under a fixed
 * key name and wired through a custom `model_provider`, so the same code path
 * serves the hosted OpenAI API and any Responses-compatible gateway (the org's
 * BYOK), not just a single hardcoded provider.
 */
export const resolveStellaSandboxRun = (input: StellaSandboxRunInput) => {
  if (input.harness !== "codex") {
    panic(
      `resolveStellaSandboxRun: harness "${input.harness}" is not wired yet`,
    );
  }

  const adapter = codexText(input.harnessModel, buildCodexAdapterConfig(input));

  const middleware = withSandbox(defineStellaSandbox(input));

  return { adapter, middleware };
};
