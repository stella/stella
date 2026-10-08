import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { generateAnalysis } from "@/api/handlers/case-law/analysis/generate";
import { ANALYSIS_SYSTEM_PROMPTS } from "@/api/handlers/case-law/analysis/prompts/prompt-registry";
import { decisionSampleForPrompt } from "@/api/handlers/case-law/research/columns-suggest-prompt";
import * as chatBuilders from "@/api/handlers/chat/chat-prompt";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import * as analysisBuilders from "@/api/lib/case-law/analysis-prompt";
import { runResearchAnswers } from "@/api/lib/case-law/research-answer-runner";
import * as researchBuilders from "@/api/lib/case-law/research-answers";
import * as suggestionBuilders from "@/api/lib/properties/column-prompt-suggestion";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const MARKER = "decision-text-fixture-7c41e9";
const DECISION_ID = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000031",
);
const ORGANIZATION_ID = toSafeId<"organization">("org_prompt_census");
const COLUMN_ID = toSafeId<"caseLawResearchColumn">(
  "00000000-0000-4000-8000-000000000032",
);
const CASE_NUMBER = "1 Test 31/2026";
const descriptor = {
  license: "restricted",
  attribution: null,
  allowsRedistribution: true,
  allowsDerivedAi: false,
};
const ast = {
  version: 1,
  source: { system: "test", documentId: "test", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: CASE_NUMBER,
    ecli: null,
    court: "Court",
    decisionDate: "2026-01-01",
    decisionType: "judgment",
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "a-1",
      anchorId: "a-1",
      type: "paragraph",
      plainText: MARKER,
      inlines: [{ type: "text", text: MARKER }],
    },
  ],
} satisfies DocumentAst;
const row = {
  id: DECISION_ID,
  country: "CZE",
  caseNumber: CASE_NUMBER,
  court: "Court",
  courtAbbreviation: null,
  decisionDate: "2026-01-01",
  decisionType: "judgment",
  language: "cs",
  analysis: null,
  metadata: {},
  documentUrl: null,
  documentAst: ast,
  astS3Key: null,
  textS3Key: null,
  contentHash: null,
  fulltext: MARKER,
  source: { adapterKey: "test", descriptor },
};
const unusedSafeDb: SafeDb = () =>
  panic("This prompt fixture does not read tenant data");
const publicReader = () => {
  const tx = asTestRaw<CaseLawPublicReadTransaction>({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              {
                id: DECISION_ID,
                country: "CZE",
                descriptor,
                published: true,
                absorption: null,
              },
            ],
          }),
        }),
      }),
    }),
    query: { caseLawDecisions: { findFirst: async () => row } },
  });
  const read = async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) => await fn(tx);
  return Object.assign(read, caseLawPublicReadDb);
};

const activeDecisionProbe = async () => {
  const result = await chatBuilders.buildActiveDecisionSection({
    activeDecision: { decisionId: DECISION_ID },
    caseLawDb: publicReader(),
    safeDb: unusedSafeDb,
    organizationId: undefined,
    userId: undefined,
  });
  expect(result.unwrap()).toContain(CASE_NUMBER);
  expect(result.unwrap()).not.toContain(MARKER);
};
const suggestionProbe = () => {
  const sample = decisionSampleForPrompt({
    caseNumber: CASE_NUMBER,
    court: "Court",
    decisionDate: "2026-01-01",
    headnote: { type: "present", text: MARKER, truncated: false },
    textWithheldReason: "source_licence",
  });
  const prompt = suggestionBuilders.buildSuggestPromptUserMessage({
    name: "Outcome",
    instruction: "Refine",
    contentType: "text",
    options: undefined,
    currentPrompt: undefined,
    context: {
      kind: "case-law",
      country: "CZE",
      query: "test",
      filters: {
        court: undefined,
        dateFrom: undefined,
        dateTo: undefined,
        decisionType: undefined,
        language: undefined,
      },
      samples: [sample],
    },
  });
  expect(prompt).toContain(CASE_NUMBER);
  expect(prompt).not.toContain(MARKER);
};
const analysisProbe = async (language: string) => {
  let starts = 0;
  let reads = 0;
  const scopedDb = asTestRaw<ScopedDb>(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      await fn({
        query: {
          caseLawDecisions: {
            findFirst: async () => {
              reads += 1;
              return { ...row, language };
            },
          },
        },
      }),
  );
  const result = await generateAnalysis({
    decisionId: DECISION_ID,
    scopedDb,
    organizationId: ORGANIZATION_ID,
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
    admitModelAction: async () =>
      panic("This decision does not admit model work"),
    startModelAction: async () => {
      starts += 1;
      return panic("This decision does not start model work");
    },
  });
  expect(reads).toBe(1);
  expect(result.unwrap()).toEqual({
    status: "error",
    error: "Analysis is unavailable for this decision",
  });
  expect(starts).toBe(0);
};
const researchProbe = async () => {
  const outcomes: unknown[] = [];
  let reads = 0;
  let textReads = 0;
  const select = { from: () => select, where: () => select };
  const tx = {
    select: () => ({
      from: () => ({ where: async () => [{ columnId: COLUMN_ID }] }),
    }),
    update: () => ({
      set: (values: unknown) => {
        outcomes.push(values);
        return { where: async () => undefined };
      },
    }),
  };
  // The update builds its ownership subquery without executing it.
  const writeTx = { ...tx, select: () => select };
  let tenantReads = 0;
  const safeDb = asTestRaw<SafeDb>(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      tenantReads += 1;
      return Result.ok(await fn(tenantReads === 1 ? tx : writeTx));
    },
  );
  const caseLawDb = Object.assign(
    async <T>(fn: (tx: CaseLawPublicReadTransaction) => Promise<T>) =>
      await fn(
        asTestRaw<CaseLawPublicReadTransaction>({
          query: {
            caseLawDecisions: {
              findFirst: async () => {
                reads += 1;
                return {
                  ...row,
                  get fulltext() {
                    textReads += 1;
                    return MARKER;
                  },
                };
              },
            },
          },
        }),
      ),
    caseLawPublicReadDb,
  );
  await runResearchAnswers(
    {
      admission: testModelAdmission(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
      userId: toSafeId<"user">("user_prompt_census"),
      columns: [
        {
          columnId: COLUMN_ID,
          question: "Outcome?",
          content: { version: 1, type: "text" },
        },
      ],
      claim: {
        claimId: toSafeId<"caseLawResearchAnswerClaim">(
          "00000000-0000-4000-8000-000000000033",
        ),
        cells: [{ columnId: COLUMN_ID, decisionId: DECISION_ID }],
      },
      orgAIConfig: null,
      managedAIResidency: "eu",
      promptCachingEnabled: false,
    },
    { safeDb, caseLawDb, decisionModel: null },
  );
  expect(reads).toBe(1);
  expect(textReads).toBe(0);
  expect(outcomes).toHaveLength(1);
  expect(outcomes.at(0)).toMatchObject({ state: "not_allowed" });
  expect(JSON.stringify(outcomes)).not.toContain(MARKER);
};

const CHECKS = {
  activeDecision: activeDecisionProbe,
  suggestion: suggestionProbe,
  research: researchProbe,
};
type FunctionKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];
type Policy =
  | {
      readonly type: "guarded";
      readonly check: keyof typeof CHECKS | "analysis";
    }
  | { readonly type: "no-decision-text"; readonly reason: string };
const ACTIVE_DECISION = { type: "guarded", check: "activeDecision" } as const;
const ANALYSIS = { type: "guarded", check: "analysis" } as const;
const RESEARCH = { type: "guarded", check: "research" } as const;
const SUGGESTION = { type: "guarded", check: "suggestion" } as const;
const CALLER = {
  type: "no-decision-text",
  reason: "formats caller context, instructions, legislation, or metadata",
} as const;
const CHAT_POLICY = {
  buildCorpusOnlyCaseLawSection: CALLER,
  chatVolatilePromptSection: CALLER,
  chatSafePromptText: CALLER,
  appendAnonymizedModeHintToChatSafePrompt: CALLER,
  extendChatUntrustedPromptSuffix: CALLER,
  buildChatPromptCacheKey: CALLER,
  buildChatSystemPromptParts: ACTIVE_DECISION,
  buildContextMatterScopeSection: CALLER,
  buildActiveDraftPrompt: CALLER,
  extractTitle: CALLER,
  buildGlobalPrompt: CALLER,
  buildGlobalPromptParts: CALLER,
  estimateChatContextPromptTokens: CALLER,
  buildWorkspacePromptText: CALLER,
  buildWorkspacePromptParts: CALLER,
  buildActiveTemplatePrompt: CALLER,
  buildActiveDecisionPrompt: ACTIVE_DECISION,
  formatAnnotationsForPrompt: ACTIVE_DECISION,
  buildActiveDecisionSection: ACTIVE_DECISION,
  buildActiveStatutePrompt: CALLER,
  buildActiveStatuteSection: CALLER,
  buildRequestedSkillsSection: CALLER,
  buildActiveSkillSection: CALLER,
  buildActiveFileSection: CALLER,
  buildUserContextBlock: CALLER,
} as const satisfies Record<FunctionKeys<typeof chatBuilders>, Policy>;
const ANALYSIS_POLICY = {
  formatDecisionForPrompt: ANALYSIS,
  analysisInputOf: ANALYSIS,
} as const satisfies Record<FunctionKeys<typeof analysisBuilders>, Policy>;
const RESEARCH_POLICY = {
  defaultResearchColumnTool: CALLER,
  selectPassagesWithinBudget: RESEARCH,
  buildResearchUserMessage: RESEARCH,
  buildResearchAnswersSchema: CALLER,
  statedAnswerContent: CALLER,
  parseResearchAnswers: CALLER,
  buildAnswerJustification: CALLER,
  parseStoredAnswerContent: CALLER,
} as const satisfies Record<FunctionKeys<typeof researchBuilders>, Policy>;
const SUGGESTION_POLICY = {
  buildSuggestPromptUserMessage: SUGGESTION,
  sanitizeSuggestion: CALLER,
  suggestColumnPrompt: SUGGESTION,
} as const satisfies Record<FunctionKeys<typeof suggestionBuilders>, Policy>;

const MODULE_POLICIES = [
  { exports: chatBuilders, policy: CHAT_POLICY },
  { exports: analysisBuilders, policy: ANALYSIS_POLICY },
  { exports: researchBuilders, policy: RESEARCH_POLICY },
  { exports: suggestionBuilders, policy: SUGGESTION_POLICY },
];
test("prompt decisions cover every owning module function", () => {
  const checks = new Set<string>();
  for (const module of MODULE_POLICIES) {
    expect(Object.keys(module.policy).toSorted()).toEqual(
      Object.entries(module.exports)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => name)
        .toSorted(),
    );
    for (const entry of Object.values(module.policy)) {
      if (entry.type === "guarded") {
        checks.add(entry.check);
      }
    }
  }
  expect([...checks].toSorted()).toEqual(
    [...Object.keys(CHECKS), "analysis"].toSorted(),
  );
});
for (const [name, check] of Object.entries(CHECKS)) {
  test(`${name} prompts preserve decision text policy`, check);
}
const ANALYSIS_DISPATCH_PROBES = {
  cs: analysisProbe,
  sk: analysisProbe,
  de: analysisProbe,
  en: analysisProbe,
  pl: analysisProbe,
} as const satisfies Record<
  keyof typeof ANALYSIS_SYSTEM_PROMPTS,
  typeof analysisProbe
>;
test("analysis dispatch probes cover every prompt language", () => {
  expect(Object.keys(ANALYSIS_DISPATCH_PROBES).toSorted()).toEqual(
    Object.keys(ANALYSIS_SYSTEM_PROMPTS).toSorted(),
  );
});
test.each(
  Object.entries(ANALYSIS_DISPATCH_PROBES).map(([language, check]) => ({
    language,
    check,
  })),
)(
  "$language analysis dispatch preserves decision text policy",
  async ({ language, check }) => await check(language),
);
