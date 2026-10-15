/**
 * Analysis generation for a decision whose language has no analysis prompt.
 *
 * The decision has a parseable tree, so the refusal is the language alone:
 * the handler must answer it as an error and never start a run. A run
 * starts by claiming the decision row through the shared pool, which a
 * hermetic test points at the counting sentinel, so a claim is observable
 * as a sentinel connection.
 */

import { Result, panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";
import type { DocumentAst, ParagraphBlock } from "@stll/legal-ast/document-ast";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { rootPoolConnectionCount } from "@/api/tests/test-database-environment";

import { generateAnalysis } from "./generate";
import { getSystemPrompt } from "./prompts/prompt-registry";

const ORGANIZATION_ID = toSafeId<"organization">("org_test");
const USER_ID = toSafeId<"user">("user_test");
const UNSUPPORTED_LANGUAGE = "fr";

const paragraph = (anchorId: string, plainText: string): ParagraphBlock => ({
  id: anchorId,
  anchorId,
  type: "paragraph",
  plainText,
  inlines: [{ type: "text", text: plainText }],
});

const documentAst = {
  version: 1,
  source: { system: "test", documentId: "test", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: "21-10.001",
    ecli: null,
    court: "Cour de cassation",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    paragraph("b1", "Arrêt"),
    paragraph("b2", "La Cour rejette le pourvoi."),
  ],
} satisfies DocumentAst;

// An organization key for the fast role, so the AI availability check
// passes: a decision that slipped past the language refusal would go on to
// claim the row rather than stop at a missing provider.
const orgAIConfig = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
  decision: null,
} satisfies OrgAIConfig;

describe("generating an analysis for a decision in a language with no prompt", () => {
  let db: TestDatabase;
  let decisionId: SafeId<"caseLawDecision">;

  beforeAll(async () => {
    db = await getTestDb();
    const [source] = await db
      .insert(caseLawSources)
      .values({
        name: `analysis-language-${Bun.randomUUIDv7().slice(0, 8)}`,
        adapterKey: ADAPTER_KEYS.CZ_NS,
      })
      .returning({ id: caseLawSources.id });
    if (!source) {
      throw new Error("expected a case-law source row");
    }
    const [row] = await db
      .insert(caseLawDecisions)
      .values({
        sourceId: source.id,
        caseNumber: "21-10.001",
        court: "Cour de cassation",
        country: "FRA",
        language: UNSUPPORTED_LANGUAGE,
        documentAst,
      })
      .returning({ id: caseLawDecisions.id });
    if (!row) {
      throw new Error("expected a decision row");
    }
    decisionId = row.id;
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  test("answers the unsupported-language error and starts no run", async () => {
    // The fixture reaches the language branch: the tree parses, and the
    // registry has no prompt for the language.
    expect(parseCaseLawDecisionAst(documentAst)).not.toBeNull();
    expect(Result.isError(getSystemPrompt(UNSUPPORTED_LANGUAGE))).toBe(true);

    const claimsBefore = rootPoolConnectionCount();
    expect(claimsBefore).not.toBeNull();

    const response = await generateAnalysis({
      admitModelAction: async () =>
        panic("Unsupported languages must not admit a model action"),
      startModelAction: async () =>
        panic("Unsupported languages must not start a model action"),
      decisionId,
      scopedDb: executeRowsScopedDb(
        createScopedDb(db, [], ORGANIZATION_ID, USER_ID),
      ),
      organizationId: ORGANIZATION_ID,
      orgAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      promptCachingEnabled: false,
      retry: false,
    });

    expect(response.unwrap()).toEqual({
      status: "error",
      code: "language_unsupported",
      error: `Analysis is not available for decisions in language "${UNSUPPORTED_LANGUAGE}"`,
    });
    expect(rootPoolConnectionCount()).toBe(claimsBefore);
  });
});
