import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { FEEDBACK_WORKFLOW_REFERENCE_URI } from "@/api/mcp/feedback-workflow-reference";
import {
  getMcpInstructions,
  MCP_INSTRUCTIONS,
  MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS,
  MCP_INSTRUCTIONS_DEFAULT_MAX_CHARS,
  MCP_INSTRUCTIONS_DOCUMENTS_MAX_CHARS,
  MCP_INSTRUCTIONS_LAW_MAX_CHARS,
} from "@/api/mcp/instructions";
import { LEGISLATION_WORKFLOW_REFERENCE_URI } from "@/api/mcp/legislation-workflow-reference";
import { LAW_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import { TEMPLATE_WORKFLOW_REFERENCE_URI } from "@/api/mcp/template-workflow-reference";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";

// The server `instructions` ride on every initialize response, so they are a
// per-session token cost. These budgets are hard ceilings: growth past them
// must be a deliberate, reviewed constant bump, not silent drift.
describe("MCP server instructions", () => {
  test("default instructions stay within the character budget", () => {
    expect(MCP_INSTRUCTIONS.default.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_DEFAULT_MAX_CHARS,
    );
  });

  test("anonymized instructions stay within the tighter budget", () => {
    expect(MCP_INSTRUCTIONS.anonymized.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS,
    );
  });

  test("documents instructions stay within the tighter budget", () => {
    expect(MCP_INSTRUCTIONS.documents.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_DOCUMENTS_MAX_CHARS,
    );
  });

  test("law instructions stay within the tighter budget", () => {
    expect(MCP_INSTRUCTIONS.law.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_LAW_MAX_CHARS,
    );
  });

  test("all surfaces are non-empty and selected by mode", () => {
    expect(MCP_INSTRUCTIONS.default.length).toBeGreaterThan(0);
    expect(MCP_INSTRUCTIONS.anonymized.length).toBeGreaterThan(0);
    expect(MCP_INSTRUCTIONS.documents.length).toBeGreaterThan(0);
    expect(getMcpInstructions("anonymized")).toBe(MCP_INSTRUCTIONS.anonymized);
    expect(getMcpInstructions("documents")).toBe(MCP_INSTRUCTIONS.documents);
    expect(MCP_INSTRUCTIONS.law.length).toBeGreaterThan(0);
    expect(getMcpInstructions("law")).toBe(MCP_INSTRUCTIONS.law);
  });

  test("all surfaces provide canonical product identity without inference", () => {
    for (const instructions of Object.values(MCP_INSTRUCTIONS)) {
      expect(instructions).toContain("stella (always lowercase");
      expect(instructions).toContain("https://stll.app");
      expect(instructions).toContain("stella://about");
      expect(instructions).toContain("Never infer stella branding or URLs");
    }
  });

  test("the default surface points at the template workflow resource", () => {
    // The resource is listed, but an agent that never calls resources/list
    // starts at create_template and rediscovers the order by trial.
    expect(MCP_INSTRUCTIONS.default).toContain(TEMPLATE_WORKFLOW_REFERENCE_URI);
  });

  test("the default surface points at the legislation workflow resource", () => {
    // Same reason as the template workflow: an agent that never calls
    // resources/list starts at search_legislation and has to discover by
    // trial that a point-in-time question is answered by read_statute.
    expect(MCP_INSTRUCTIONS.default).toContain(
      LEGISLATION_WORKFLOW_REFERENCE_URI,
    );
  });

  // The budgets above bound the worst case, so `MCP_INSTRUCTIONS` is built
  // with every gate open; what a deployment serves comes from
  // `getMcpInstructions`, and a gate-off deployment advertises none of the
  // legislation tools the workflow tells a model to call.
  const withPublicLaw = (
    {
      featurePublicLaw,
      localDevOpen,
    }: { featurePublicLaw: boolean; localDevOpen: boolean },
    run: () => void,
  ) => {
    const previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
    env.FEATURE_PUBLIC_LAW = featurePublicLaw;
    const restoreRuntimeMode = setRuntimeModeForTesting({
      mode: localDevOpen ? RUNTIME_MODE.open : RUNTIME_MODE.strict,
    });
    try {
      run();
    } finally {
      env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
      restoreRuntimeMode();
    }
  };

  test("serves the legislation pointer only while the public-law gate is open", () => {
    withPublicLaw({ featurePublicLaw: true, localDevOpen: false }, () => {
      const served = getMcpInstructions("default");
      expect(served).toContain(LEGISLATION_WORKFLOW_REFERENCE_URI);
      expect(served).toBe(MCP_INSTRUCTIONS.default);
    });

    withPublicLaw({ featurePublicLaw: false, localDevOpen: false }, () => {
      const served = getMcpInstructions("default");
      expect(served).not.toContain(LEGISLATION_WORKFLOW_REFERENCE_URI);
      // The template workflow is not gated, so it stays.
      expect(served).toContain(TEMPLATE_WORKFLOW_REFERENCE_URI);
    });

    // Dev sees everything, like the tool list.
    withPublicLaw({ featurePublicLaw: false, localDevOpen: true }, () => {
      expect(getMcpInstructions("default")).toContain(
        LEGISLATION_WORKFLOW_REFERENCE_URI,
      );
    });
  });

  test("the law surface names every tool it serves and nothing it does not", () => {
    // The whole point of this audience is a tool list an orchestrator can hold
    // in one prompt, so the connect text names it rather than making the agent
    // infer it from tools/list.
    for (const { name } of LAW_MCP_TOOL_DEFINITIONS) {
      expect(
        MCP_INSTRUCTIONS.law,
        `${name} is served but never named`,
      ).toContain(name);
    }
    expect(MCP_INSTRUCTIONS.law).toContain(LEGISLATION_WORKFLOW_REFERENCE_URI);
    expect(MCP_INSTRUCTIONS.law).toContain(
      "no matter, document, contact or billing data is reachable here",
    );
    expect(MCP_INSTRUCTIONS.law).not.toContain("prepare_feedback");
    expect(MCP_INSTRUCTIONS.law).not.toContain("submit_feedback");
    expect(MCP_INSTRUCTIONS.law).not.toContain("invoke_capability");
  });

  test("the law surface names its tools only while the gate is open", () => {
    // The whole law tool list rides the public-law gate, so a gate-off
    // deployment serves an empty tools/list there: naming its tools
    // would be the same dead end the default surface avoids above.
    withPublicLaw({ featurePublicLaw: true, localDevOpen: false }, () => {
      expect(getMcpInstructions("law")).toBe(MCP_INSTRUCTIONS.law);
    });

    withPublicLaw({ featurePublicLaw: false, localDevOpen: false }, () => {
      const served = getMcpInstructions("law");
      for (const { name } of LAW_MCP_TOOL_DEFINITIONS) {
        expect(
          served,
          `${name} must not be named while the gate is closed`,
        ).not.toContain(name);
      }
      expect(served).not.toContain(LEGISLATION_WORKFLOW_REFERENCE_URI);
      expect(served).toContain("not enabled on this deployment");
    });

    withPublicLaw({ featurePublicLaw: false, localDevOpen: true }, () => {
      expect(getMcpInstructions("law")).toBe(MCP_INSTRUCTIONS.law);
    });
  });

  test("only the default surface points at the feedback flow", () => {
    // Both steps are named: a pointer that stops at the draft leaves the
    // report sitting in the model's context, unsent.
    expect(MCP_INSTRUCTIONS.default).toContain("prepare_feedback");
    expect(MCP_INSTRUCTIONS.default).toContain("submit_feedback");
    expect(MCP_INSTRUCTIONS.default).toContain(FEEDBACK_WORKFLOW_REFERENCE_URI);
    for (const surface of [
      MCP_INSTRUCTIONS.anonymized,
      MCP_INSTRUCTIONS.documents,
      MCP_INSTRUCTIONS.law,
    ]) {
      expect(surface).not.toContain("prepare_feedback");
      expect(surface).not.toContain("submit_feedback");
    }
  });
});
