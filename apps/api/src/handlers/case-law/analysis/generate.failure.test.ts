import { panic, Result } from "better-result";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import * as failureOwner from "@/api/lib/case-law/analysis-failure";
import * as analysisOwner from "@/api/lib/case-law/analysis-store";
import { analysisSentinel } from "@/api/lib/case-law/stored-analysis";
import { createProviderCallError } from "@/api/lib/errors/provider-call-failure";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { DetachedModelActionStarter } from "@/api/lib/rate-limit/model-action-admission";
import { NO_ORGANIZATION_MODEL_DISPATCH } from "@/api/lib/rate-limit/model-dispatch-admission";
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
    fast: { provider: "openai", modelId: modelIds.fast },
    chat: { provider: "openai", modelId: modelIds.chat },
    reasoning: { provider: "openai", modelId: modelIds.reasoning },
    pdf: { provider: "openai", modelId: modelIds.pdf },
  },
  decision: null,
} satisfies OrgAIConfig;

const owners = (stored: unknown = null) => {
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
  } as const satisfies AnalysisInputResolution;
  spyOn(inputOwner, "resolveAnalysisInput").mockResolvedValue(resolution);
  const store = {
    peek: () => null,
    claim: async () => analysisSentinel(fingerprint, new Date()),
    save: async () => true,
    clear: async () => await Promise.resolve(),
  };
  spyOn(analysisOwner, "analysisStore").mockReturnValue(store);
  spyOn(analysisOwner, "storesAnalyses").mockReturnValue(true);
  return store;
};

const options = {
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
        ? {
            version: 2,
            generatedAt: "2026-09-01T12:00:00.000Z",
            model: "fixture",
            inputFingerprint: fingerprint,
            tree: [],
          }
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

test("a scoped background failure is delivered once before the next explicit request retries", async () => {
  owners();
  const diagnostic = {
    provider: "openai",
    code: "ai_config_openai_insufficient_quota",
    message: "Full provider quota reason",
  } as const;
  let failure: {
    status: "error";
    providerDiagnostic: typeof diagnostic;
  } | null = { status: "error", providerDiagnostic: diagnostic };
  const scopes: unknown[] = [];
  spyOn(failureOwner, "analysisFailureStore").mockReturnValue({
    write: async () => await Promise.resolve(),
    take: async (scope) => {
      scopes.push(scope);
      const reply = failure;
      failure = null;
      return reply;
    },
  });
  const first = await generateAnalysis(options);
  expect(first.unwrap()).toEqual({
    status: "error",
    error: "Analysis generation failed",
    providerDiagnostic: diagnostic,
  });
  const retry = await generateAnalysis(options);
  expect(Result.isError(retry)).toBe(true);
  if (Result.isError(retry)) {
    expect(retry.error.message).toBe("Analysis generation could not start");
  }
  expect(scopes).toEqual([
    { organizationId, decisionId, fingerprint },
    { organizationId, decisionId, fingerprint },
  ]);
});

test("a failure-delivery read outage is captured and returned explicitly without starting generation", async () => {
  owners();
  spyOn(failureOwner, "analysisFailureStore").mockReturnValue({
    write: async () => await Promise.resolve(),
    take: async () => {
      throw new failureOwner.AnalysisFailureStoreError({
        message: "Fixture unavailable",
      });
    },
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
    admission: NO_ORGANIZATION_MODEL_DISPATCH,
    signal: AbortSignal.timeout(1000),
  };
  const sentinel = await start(admitted);
  await background(admitted, sentinel);
  return Result.ok(sentinel);
};

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
      take: async () => null,
      write: async (scope, providerDiagnostic) => {
        operations.push("write");
        snapshots.push({ scope, providerDiagnostic });
        if (delivery === "outage") {
          throw new failureOwner.AnalysisFailureStoreError({
            message: "Fixture unavailable",
            cause: providerDiagnostic,
          });
        }
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
