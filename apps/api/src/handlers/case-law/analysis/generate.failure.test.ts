import { panic, Result } from "better-result";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";
import type { PersistedDecisionAnalysis } from "@stll/legal-ast/analysis";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import * as failureOwner from "@/api/lib/case-law/analysis-failure";
import * as analysisOwner from "@/api/lib/case-law/analysis-store";
import { analysisSentinel } from "@/api/lib/case-law/stored-analysis";
import { createProviderCallError } from "@/api/lib/errors/provider-call-failure";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { redactedProviderDiagnostic } from "@/api/lib/provider-diagnostic";
import type { DetachedModelActionStarter } from "@/api/lib/rate-limit/model-action-admission";
import { admitFixtureModelDispatch } from "@/api/lib/rate-limit/model-dispatch-admission";
import * as generation from "@/api/lib/tanstack-ai-generate";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import * as inputOwner from "./analysis-input";
import type { AnalysisInputResolution } from "./analysis-input";
import { generateAnalysis } from "./generate";

const organizationId = toSafeId<"organization">("org_analysis_failure");
const decisionId = toSafeId<"caseLawDecision">("decision_analysis_failure");
const fingerprint = "f".repeat(64);
const modelIds = BYOK_DEFAULT_MODELS.openai;
const orgAIConfig = {
  providers: [{ provider: "openai", apiKey: "fixture-key" }],
  overrideModels: {
    fast: { provider: "openai", modelId: modelIds.fast.modelId },
    chat: { provider: "openai", modelId: modelIds.chat.modelId },
    reasoning: { provider: "openai", modelId: modelIds.reasoning.modelId },
    pdf: { provider: "openai", modelId: modelIds.pdf.modelId },
  },
  decision: null,
} satisfies OrgAIConfig;

const owners = (stored: PersistedDecisionAnalysis | null = null) => {
  const resolution = {
    kind: "resolved",
    decision: {
      id: decisionId,
      language: "cs",
      court: "Fixture court",
      country: "CZE",
      decisionType: null,
      documentAst: null,
      analysis: stored,
      astS3Key: null,
      contentHash: null,
      caseNumber: "Fixture case",
      ecli: null,
      decisionDate: null,
      documentUrl: null,
      metadata: null,
      source: { adapterKey: ADAPTER_KEYS.CZ_NS, descriptor: null },
    },
    input: {
      language: "cs",
      systemPrompt: "Fixture system",
      userMessage: "Fixture input",
      fingerprint,
    },
    anchorIds: [],
  } satisfies AnalysisInputResolution;
  spyOn(inputOwner, "resolveAnalysisInput").mockResolvedValue(resolution);
  let held: unknown = null;
  const store = {
    peek: () => held,
    claim: async ({
      observed,
    }: Parameters<analysisOwner.AnalysisStore["claim"]>[0]) => {
      if (held !== null && held !== observed) {
        return null;
      }
      const sentinel = analysisSentinel(fingerprint, new Date());
      held = sentinel;
      return sentinel;
    },
    save: async () => true,
    clear: async ({
      sentinel,
    }: Parameters<analysisOwner.AnalysisStore["clear"]>[0]) => {
      if (held === sentinel) {
        held = null;
      }
      await Promise.resolve();
    },
  };
  spyOn(analysisOwner, "analysisStore").mockReturnValue(store);
  spyOn(analysisOwner, "storesAnalyses").mockReturnValue(true);
  return store;
};

const options = {
  mode: "poll",
  organizationId,
  decisionId,
  orgAIConfig,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  promptCachingEnabled: false,
  scopedDb: async () => panic("The input owner supplies the resolved fixture"),
  admitModelAction: async () => panic("No significance work is expected"),
  startModelAction: async () =>
    Result.err(
      new HandlerError({
        status: 503,
        message: "Fixture retry reached generation",
      }),
    ),
} satisfies Parameters<typeof generateAnalysis>[0];

afterEach(() => {
  mock.restore();
});

for (const status of ["done", "generating"] as const) {
  test(`stored ${status} analysis bypasses failure coordination`, async () => {
    const stored =
      status === "done"
        ? ({
            version: 2,
            generatedAt: "2026-09-01T12:00:00.000Z",
            model: "fixture",
            inputFingerprint: fingerprint,
            tree: [],
          } satisfies PersistedDecisionAnalysis)
        : analysisSentinel(fingerprint, new Date());
    owners(stored);
    spyOn(analysisOwner, "storesAnalyses").mockReturnValue(false);
    const coordination = spyOn(
      failureOwner,
      "analysisFailureStore",
    ).mockImplementation(() =>
      panic("Stored results must not read failure coordination"),
    );
    expect((await generateAnalysis(options)).unwrap().status).toBe(status);
    expect(coordination).not.toHaveBeenCalled();
  });
}

const diagnostic = redactedProviderDiagnostic({
  provider: "openai",
  code: "ai_config_openai_insufficient_quota",
  message: "Full provider quota reason",
});

const terminalFailureStore = async () => {
  const values = new Map<string, string>();
  const commands: string[] = [];
  const store = failureOwner.createAnalysisFailureStore({
    createRedis: () => ({
      connect: async () => await Promise.resolve(),
      send: async (command, args) => {
        commands.push(command);
        const key =
          args.at(command === "EVAL" ? 2 : 0) ??
          panic("Expected coordination key");
        switch (command) {
          case "SET":
            values.set(key, args.at(1) ?? panic("Expected failure value"));
            return "OK";
          case "GET":
            return values.get(key) ?? null;
          case "GETDEL": {
            const value = values.get(key) ?? null;
            values.delete(key);
            return value;
          }
          case "EVAL":
            if (
              JSON.parse(values.get(key) ?? "null")?.failureId !== args.at(3)
            ) {
              return 0;
            }
            return values.delete(key) ? 1 : 0;
          default:
            return panic(`Unexpected coordination command ${command}`);
        }
      },
    }),
  });
  expect(
    (
      await store.write({ organizationId, decisionId, fingerprint }, diagnostic)
    ).isOk(),
  ).toBe(true);
  spyOn(failureOwner, "analysisFailureStore").mockReturnValue(store);
  return { store, commands };
};

test("two polls retain the same terminal failure and make no model calls", async () => {
  owners();
  const { commands } = await terminalFailureStore();
  const model = spyOn(
    generation,
    "generateTanStackObjectForRole",
  ).mockRejectedValue(
    new HandlerError({ status: 503, message: "Unexpected model call" }),
  );
  let starts = 0;
  const startModelAction: DetachedModelActionStarter = async (work) => {
    starts++;
    return await runBackground(work);
  };
  for (let poll = 0; poll < 2; poll++) {
    expect(
      (await generateAnalysis({ ...options, startModelAction })).unwrap(),
    ).toEqual({
      status: "error",
      error: "Analysis generation failed",
      providerDiagnostic: diagnostic,
    });
  }
  expect(model).toHaveBeenCalledTimes(0);
  expect(starts).toBe(0);
  expect(commands).toEqual(["SET", "GET", "GET"]);
});

for (const schedule of ["single", "concurrent", "delayed-admission"] as const) {
  test(`${schedule} explicit retries clear the observed failure and start exactly one model call`, async () => {
    const retries = schedule === "single" ? 1 : 2;
    owners();
    const { commands, store } = await terminalFailureStore();
    const error = createProviderCallError({
      model: { provider: "openai", keySource: "byok" },
      status: 429,
      evidence: {
        error: { code: "insufficient_quota", message: "New terminal failure" },
      },
    });
    const model = spyOn(
      generation,
      "generateTanStackObjectForRole",
    ).mockRejectedValue(error);
    const analytics = installRecordingAnalytics();
    const logs = installRecordingLogger();
    try {
      const firstSettled = Promise.withResolvers<undefined>();
      let starts = 0;
      const startModelAction: DetachedModelActionStarter = async (work) => {
        const position = starts++;
        if (schedule === "delayed-admission" && position > 0) {
          await firstSettled.promise;
        }
        const result = await runBackground(work);
        if (position === 0) {
          firstSettled.resolve(undefined);
        }
        return result;
      };
      const results = await Promise.all(
        Array.from(
          { length: retries },
          async () =>
            await generateAnalysis({
              ...options,
              mode: "retry",
              startModelAction,
            }),
        ),
      );
      expect(results.map((result) => result.unwrap())).toEqual(
        Array.from({ length: retries }, () => ({ status: "generating" })),
      );
      expect(model).toHaveBeenCalledTimes(1);
      expect(commands.filter((command) => command === "EVAL")).toHaveLength(
        schedule === "delayed-admission" ? 2 : 1,
      );
      expect(commands.indexOf("EVAL")).toBeLessThan(
        commands.lastIndexOf("SET"),
      );
      expect(
        (
          await store.read({ organizationId, decisionId, fingerprint })
        ).unwrap(),
      ).toMatchObject({
        status: "error",
        providerDiagnostic: error.providerDiagnostic,
      });
    } finally {
      logs.restore();
      analytics.restore();
    }
  });
}

test("a failure-delivery read outage is captured and returned explicitly without starting generation", async () => {
  owners();
  spyOn(failureOwner, "analysisFailureStore").mockReturnValue({
    write: async () => Result.ok(undefined),
    clear: async () => Result.ok(true),
    read: async () =>
      Result.err(
        new failureOwner.AnalysisFailureStoreError({
          message: "Fixture unavailable",
        }),
      ),
  });
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  try {
    const result = await generateAnalysis(options);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 503,
        message: "Analysis failure delivery is unavailable",
      });
    }
    expect(analytics.exceptions().length).toBeGreaterThan(0);
  } finally {
    logs.restore();
    analytics.restore();
  }
});

const runBackground: DetachedModelActionStarter = async ({
  start,
  background,
}) => {
  const admitted = {
    admission: admitFixtureModelDispatch({
      organizationId,
      actionKind: "case-law.analysis",
    }),
    signal: AbortSignal.timeout(1000),
  };
  const sentinel = await start(admitted);
  await background(admitted, sentinel);
  return Result.ok(sentinel);
};

test("a retry clear outage preserves the failure and releases its claim without a model call", async () => {
  const analysis = owners();
  const { store } = await terminalFailureStore();
  spyOn(store, "clear").mockResolvedValue(
    Result.err(
      new failureOwner.AnalysisFailureStoreError({
        message: "Fixture unavailable",
      }),
    ),
  );
  const released = spyOn(analysis, "clear");
  const model = spyOn(generation, "generateTanStackObjectForRole");
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  try {
    const result = await generateAnalysis({
      ...options,
      mode: "retry",
      startModelAction: runBackground,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        status: 503,
        message: "Analysis failure delivery is unavailable",
      });
    }
    expect(model).toHaveBeenCalledTimes(0);
    expect(released).toHaveBeenCalledTimes(1);
    expect(
      (await store.read({ organizationId, decisionId, fingerprint })).unwrap(),
    ).toMatchObject({
      status: "error",
      providerDiagnostic: diagnostic,
    });
  } finally {
    logs.restore();
    analytics.restore();
  }
});

for (const delivery of ["available", "outage"] as const) {
  test(`background failure ${delivery} delivery never enters the shared analysis and always releases its exact sentinel`, async () => {
    const store = owners();
    const operations: string[] = [];
    const cleared = spyOn(store, "clear").mockImplementation(async () => {
      operations.push("clear");
    });
    const saved = spyOn(store, "save");
    const error = createProviderCallError({
      model: { provider: "openai", keySource: "byok" },
      status: 502,
      evidence: {
        error: {
          code: "insufficient_quota",
          message: "Full scoped provider reason",
        },
      },
    });
    spyOn(generation, "generateTanStackObjectForRole").mockRejectedValue(error);
    const snapshots: unknown[] = [];
    spyOn(failureOwner, "analysisFailureStore").mockReturnValue({
      clear: async () => Result.ok(true),
      read: async () => Result.ok(null),
      write: async (scope, providerDiagnostic) => {
        operations.push("write");
        snapshots.push({ scope, providerDiagnostic });
        if (delivery === "outage") {
          return Result.err(
            new failureOwner.AnalysisFailureStoreError({
              message: "Fixture unavailable",
              cause: providerDiagnostic,
            }),
          );
        }
        return Result.ok(undefined);
      },
    });
    const analytics = installRecordingAnalytics();
    const logs = installRecordingLogger();
    try {
      expect(
        (
          await generateAnalysis({
            ...options,
            startModelAction: runBackground,
          })
        ).unwrap(),
      ).toEqual({ status: "generating" });
      expect(operations).toEqual(["write", "clear"]);
      expect(snapshots).toEqual([
        {
          scope: { organizationId, decisionId, fingerprint },
          providerDiagnostic: error.providerDiagnostic,
        },
      ]);
      expect(saved).not.toHaveBeenCalled();
      expect(cleared).toHaveBeenCalledWith({
        decisionId,
        sentinel: expect.objectContaining({ inputFingerprint: fingerprint }),
      });
      expect(
        JSON.stringify({ logs: logs.records, analytics: analytics.events }),
      ).not.toContain("Full scoped provider reason");
    } finally {
      logs.restore();
      analytics.restore();
    }
  });
}
