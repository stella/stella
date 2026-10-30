import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { MCP_MODES } from "@/api/mcp/constants";
import {
  getMcpInstructions,
  MCP_INSTRUCTIONS,
  MCP_INSTRUCTIONS_ADVANCED_MAX_CHARS,
  MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS,
  MCP_INSTRUCTIONS_DEFAULT_MAX_CHARS,
  MCP_INSTRUCTIONS_DOCUMENTS_MAX_CHARS,
  MCP_INSTRUCTIONS_LAW_MAX_CHARS,
} from "@/api/mcp/instructions";
import { listMcpResources } from "@/api/mcp/resources";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  LAW_MCP_TOOL_DEFINITIONS,
  MODEL_VISIBLE_MCP_TOOL_DEFINITIONS,
} from "@/api/mcp/static-tool-definitions";
import { isMcpToolVisibleTo } from "@/api/mcp/tool-visibility";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";

// The server `instructions` ride on every initialize response, so they are a
// per-session token cost. These budgets are hard ceilings: growth past them
// must be a deliberate, reviewed constant bump, not silent drift.
describe("MCP server instructions", () => {
  test("maximum instructions include every resource with deployment gates closed", async () => {
    // Re-import in a fresh process so the maximum is computed after gates close.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "--preload",
        "./src/tests/setup-env.ts",
        "-e",
        `
          import { expect } from "bun:test";
          import { listSkillMetadata, loadSkill } from "@stll/skills";
          import { RUNTIME_MODE } from "@stll/runtime-mode";
          import { env } from "./src/env";
          import { setRuntimeModeForTesting } from "./src/runtime-mode";
          import { MCP_MODES } from "./src/mcp/constants";

          for (const flag of Object.keys(env)) {
            if (flag.startsWith("FEATURE_")) Reflect.set(env, flag, false);
          }
          setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
          const instructions = await import("./src/mcp/instructions");
          const budgets = {
            advanced: instructions.MCP_INSTRUCTIONS_ADVANCED_MAX_CHARS,
            default: instructions.MCP_INSTRUCTIONS_DEFAULT_MAX_CHARS,
            documents: instructions.MCP_INSTRUCTIONS_DOCUMENTS_MAX_CHARS,
            anonymized: instructions.MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS,
            law: instructions.MCP_INSTRUCTIONS_LAW_MAX_CHARS,
          };
          for (const mode of MCP_MODES) {
            const maximum = instructions.MCP_INSTRUCTIONS[mode];
            expect(maximum.length).toBeLessThanOrEqual(budgets[mode]);
            const live = await instructions.getMcpInstructions(mode);
            expect(live).not.toContain("legislation-workflow");
            if (mode !== "documents") {
              expect(maximum).toContain("legislation-workflow");
            }
          }
          for (const { name } of listSkillMetadata()) {
            expect(instructions.MCP_INSTRUCTIONS.default).toContain(name);
            for (const { path } of loadSkill(name).resources) {
              expect(instructions.MCP_INSTRUCTIONS.default).toContain(name + "/" + path);
            }
          }
          process.exit(0);
        `,
      ],
      cwd: new URL("../..", import.meta.url).pathname,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
  }, 15_000); // timeout: a cold child process re-imports the whole API module graph before it can check the closed-gate maximum

  test("default instructions stay within the character budget", async () => {
    expect(MCP_INSTRUCTIONS.default.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_DEFAULT_MAX_CHARS,
    );
  });

  test("advanced instructions stay within the character budget", () => {
    expect(MCP_INSTRUCTIONS.advanced.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_ADVANCED_MAX_CHARS,
    );
  });

  test("anonymized instructions stay within the tighter budget", () => {
    expect(MCP_INSTRUCTIONS.anonymized.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS,
    );
  });

  test("documents instructions stay within the tighter budget", async () => {
    expect(MCP_INSTRUCTIONS.documents.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_DOCUMENTS_MAX_CHARS,
    );
  });

  test("law instructions stay within the tighter budget", async () => {
    expect(MCP_INSTRUCTIONS.law.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_LAW_MAX_CHARS,
    );
  });

  test("all surfaces are non-empty and selected by mode", async () => {
    expect(MCP_INSTRUCTIONS.advanced.length).toBeGreaterThan(0);
    expect(await getMcpInstructions("advanced")).toBe(
      MCP_INSTRUCTIONS.advanced,
    );
    expect(MCP_INSTRUCTIONS.default.length).toBeGreaterThan(0);
    expect(MCP_INSTRUCTIONS.anonymized.length).toBeGreaterThan(0);
    expect(MCP_INSTRUCTIONS.documents.length).toBeGreaterThan(0);
    expect(await getMcpInstructions("anonymized")).toBe(
      MCP_INSTRUCTIONS.anonymized,
    );
    expect(await getMcpInstructions("documents")).toBe(
      MCP_INSTRUCTIONS.documents,
    );
    expect(MCP_INSTRUCTIONS.law.length).toBeGreaterThan(0);
    expect(await getMcpInstructions("law")).toBe(MCP_INSTRUCTIONS.law);
  });

  test("all surfaces provide canonical product identity without inference", async () => {
    for (const instructions of Object.values(MCP_INSTRUCTIONS)) {
      expect(instructions).toContain("stella (always lowercase");
      expect(instructions).toContain("https://stll.app");
      expect(instructions).toContain("stella-product-identity");
      expect(instructions).toContain("Never infer stella branding or URLs");
    }
  });

  test("names every reference resource served on each surface", async () => {
    for (const mode of MCP_MODES) {
      const instructions = await getMcpInstructions(mode);
      for (const { name } of await listMcpResources(mode)) {
        expect(instructions).toContain(name);
      }
    }
  });

  test("the default surface points at the template workflow resource", async () => {
    // The resource is listed, but an agent that never calls resources/list
    // starts at create_template and rediscovers the order by trial.
    expect(MCP_INSTRUCTIONS.default).toContain("template-workflow");
  });

  test("the default surface points at the legislation workflow resource", async () => {
    // Same reason as the template workflow: an agent that never calls
    // resources/list starts at search_legislation and has to discover by
    // trial that a point-in-time question is answered by read_statute.
    expect(MCP_INSTRUCTIONS.default).toContain("legislation-workflow");
  });

  // The budgets above bound the worst case, so `MCP_INSTRUCTIONS` is built
  // with every gate open; what a deployment serves comes from
  // `getMcpInstructions`, and a gate-off deployment advertises none of the
  // legislation tools the workflow tells a model to call.
  const withPublicLaw = async (
    {
      featurePublicLaw,
      localDevOpen,
    }: { featurePublicLaw: boolean; localDevOpen: boolean },
    run: () => Promise<void>,
  ) => {
    const previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
    env.FEATURE_PUBLIC_LAW = featurePublicLaw;
    const restoreRuntimeMode = setRuntimeModeForTesting({
      mode: localDevOpen ? RUNTIME_MODE.open : RUNTIME_MODE.strict,
    });
    try {
      await run();
    } finally {
      env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
      restoreRuntimeMode();
    }
  };

  test("serves the legislation pointer only while the public-law gate is open", async () => {
    await withPublicLaw(
      { featurePublicLaw: true, localDevOpen: false },
      async () => {
        const served = await getMcpInstructions("default");
        expect(served).toContain("legislation-workflow");
        expect(served).toBe(MCP_INSTRUCTIONS.default);
      },
    );

    await withPublicLaw(
      { featurePublicLaw: false, localDevOpen: false },
      async () => {
        const served = await getMcpInstructions("default");
        expect(served).not.toContain("legislation-workflow");
        // The template workflow is not gated, so it stays.
        expect(served).toContain("template-workflow");
      },
    );

    // Dev sees everything, like the tool list.
    await withPublicLaw(
      { featurePublicLaw: false, localDevOpen: true },
      async () => {
        expect(await getMcpInstructions("default")).toContain(
          "legislation-workflow",
        );
      },
    );
  });

  test("the law surface names every tool it serves and nothing it does not", async () => {
    // The whole point of this audience is a tool list an orchestrator can hold
    // in one prompt, so the connect text names it rather than making the agent
    // infer it from tools/list.
    // App-only tools serve the host's UI and are hidden from the model, so
    // the connect text names exactly the model-visible ones.
    const lawToolNames = new Set(
      LAW_MCP_TOOL_DEFINITIONS.map(({ name }) => name),
    );
    for (const tool of MODEL_VISIBLE_MCP_TOOL_DEFINITIONS) {
      if (!lawToolNames.has(tool.name)) {
        continue;
      }
      expect(
        MCP_INSTRUCTIONS.law,
        `${tool.name} is served but never named`,
      ).toContain(tool.name);
    }
    for (const tool of DEFAULT_MCP_TOOL_DEFINITIONS) {
      if (lawToolNames.has(tool.name) && !isMcpToolVisibleTo(tool, "model")) {
        expect(
          MCP_INSTRUCTIONS.law,
          `${tool.name} is app-only but named to the model`,
        ).not.toContain(tool.name);
      }
    }
    expect(MCP_INSTRUCTIONS.law).toContain("legislation-workflow");
    expect(MCP_INSTRUCTIONS.law).toContain(
      "no matter, document, contact or billing data is reachable here",
    );
    expect(MCP_INSTRUCTIONS.law).not.toContain("prepare_feedback");
    expect(MCP_INSTRUCTIONS.law).not.toContain("submit_feedback");
    expect(MCP_INSTRUCTIONS.law).not.toContain("read_capability");
    expect(MCP_INSTRUCTIONS.law).not.toContain("write_capability");
  });

  test("the law surface names its tools only while the gate is open", async () => {
    // The whole law tool list rides the public-law gate, so a gate-off
    // deployment serves an empty tools/list there: naming its tools
    // would be the same dead end the default surface avoids above.
    await withPublicLaw(
      { featurePublicLaw: true, localDevOpen: false },
      async () => {
        expect(await getMcpInstructions("law")).toBe(MCP_INSTRUCTIONS.law);
      },
    );

    await withPublicLaw(
      { featurePublicLaw: false, localDevOpen: false },
      async () => {
        const served = await getMcpInstructions("law");
        for (const { name } of LAW_MCP_TOOL_DEFINITIONS) {
          expect(
            served,
            `${name} must not be named while the gate is closed`,
          ).not.toContain(name);
        }
        expect(served).not.toContain("legislation-workflow");
        expect(served).toContain("not enabled on this deployment");
      },
    );

    await withPublicLaw(
      { featurePublicLaw: false, localDevOpen: true },
      async () => {
        expect(await getMcpInstructions("law")).toBe(MCP_INSTRUCTIONS.law);
      },
    );
  });

  test("only the default surface points at the feedback flow", async () => {
    // Both steps are named: a pointer that stops at the draft leaves the
    // report sitting in the model's context, unsent.
    expect(MCP_INSTRUCTIONS.default).toContain("prepare_feedback");
    expect(MCP_INSTRUCTIONS.default).toContain("submit_feedback");
    expect(MCP_INSTRUCTIONS.default).toContain("feedback-workflow");
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
