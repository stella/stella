import { defineSandboxPolicy, type SandboxPolicy } from "@tanstack/ai-sandbox";

/**
 * Baseline guardrails for a stella agent run. Network is denied by default:
 * the only outbound path a run has is the bridged stella MCP server, which
 * the harness reaches over the in-process tool bridge, not raw egress. Cloud
 * hosts additionally sit behind an egress-proxy allowlist (infra layer), so
 * this policy is defense-in-depth, not the sole control.
 *
 * Destructive shell verbs are denied outright; everything unmatched falls to
 * `ask` so a surprising command surfaces an approval rather than running
 * silently.
 */
export const stellaSandboxPolicy = (): SandboxPolicy =>
  defineSandboxPolicy({
    capabilities: {
      fileWrite: "allow",
      network: "deny",
    },
    commands: {
      deny: ["sudo *", "rm -rf /*", "rm -rf ~", "curl *", "wget *"],
    },
    default: "ask",
  });
