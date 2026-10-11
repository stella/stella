import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawSources,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { createGenerateDecisionAnalysisHandler } from "@/api/handlers/case-law/analysis/generate";
import { buildChatSystemPromptParts } from "@/api/handlers/chat/chat-prompt";
import { createReadLegislationHandler } from "@/api/handlers/legislation/get";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { admitLawReadOrError } from "@/api/lib/usage/law-read-admission";
import { OrganizationAccessReadError } from "@/api/lib/usage/public-law-access";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withPublicLawReaderRole } from "@/api/tests/pglite-test-db";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const organizationId = toSafeId<"organization">("org_law_admission");
const documentId = createSafeId<"legislationDocument">();
const decisionId = createSafeId<"caseLawDecision">();
const textDecisionId = createSafeId<"caseLawDecision">();
const statuteSourceId = createSafeId<"legislationSource">();
const decisionSourceId = createSafeId<"caseLawSource">();
const STATUTE_WORDING =
  "Admitted statute wording reaches the authenticated reader.";
const DECISION_WORDING =
  "Admitted decision wording reaches the authenticated chat.";

const outcomes = [
  { type: "admitted", enabled: true, status: 200 },
  { type: "not_entitled", enabled: true, status: 403 },
  { type: "missing_scope", enabled: false, status: 403 },
  { type: "access_unavailable", enabled: true, status: 503 },
] as const;

describe("organization law read admission", () => {
  let db: TestDatabase;
  beforeAll(
    async () => {
      db = await getTestDb();
      await db.insert(legislationSources).values({
        id: statuteSourceId,
        adapterKey: "law-admission-test",
        name: "Admission statute fixture",
      });
      await db.insert(legislationDocuments).values({
        id: documentId,
        sourceId: statuteSourceId,
        eli: `test/admission/${documentId}`,
        title: "Admission statute",
        country: "CZE",
        language: "cs",
        documentType: "act",
        status: "current",
        fulltext: STATUTE_WORDING,
      });
      await db.insert(caseLawSources).values(
        caseLawSourceRow({
          id: decisionSourceId,
          adapterKey: "law-admission-test",
        }),
      );
      await db.insert(caseLawDecisions).values({
        id: textDecisionId,
        sourceId: decisionSourceId,
        caseNumber: "22 Cdo 100/2026",
        country: "CZE",
        language: "cs",
        court: "Admission court",
        fulltext: DECISION_WORDING,
      });
    },
    { timeout: 120_000 },
  );
  afterAll(async () => {
    await db
      .delete(legislationDocuments)
      .where(eq(legislationDocuments.id, documentId));
    await db
      .delete(legislationSources)
      .where(eq(legislationSources.id, statuteSourceId));
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.id, textDecisionId));
    await db
      .delete(caseLawSources)
      .where(eq(caseLawSources.id, decisionSourceId));
    await releaseTestDb();
  });

  describe.each(["legislation", "decision-analysis"] as const)(
    "%s",
    (surface) => {
      test.each(outcomes)(
        "answers $type through the shared seam",
        async (outcome) => {
          let corpusReads = 0;
          let accessReads = 0;
          const admitPublicLaw: typeof admitLawReadOrError = async (
            options,
          ) => {
            expect(options.organizationId).toBe(organizationId);
            return await admitLawReadOrError({
              ...options,
              publicLawEnabled: () => outcome.enabled,
              mayReadPublicLaw: async () => {
                accessReads += 1;
                if (outcome.type === "missing_scope") {
                  return panic("Disabled law cannot read access state");
                }
                return outcome.type === "access_unavailable"
                  ? Result.err(
                      new OrganizationAccessReadError({
                        message: "Access store unavailable",
                        cause: null,
                      }),
                    )
                  : Result.ok(outcome.type === "admitted");
              },
            });
          };
          const endpoint =
            surface === "legislation"
              ? createReadLegislationHandler({
                  admissionDependencies: { admitPublicLaw },
                  legislationDb: async (read) => {
                    corpusReads += 1;
                    return await db.transaction(
                      async (tx) => await read(asTestRaw(tx)),
                    );
                  },
                })
              : createGenerateDecisionAnalysisHandler({ admitPublicLaw });
          const result = await endpoint.handler(
            asTestRaw({
              request: new Request("https://example.test/law-read"),
              route: "/law-read",
              params:
                surface === "legislation" ? { documentId } : { decisionId },
              query: {},
              user: {
                id: toSafeId<"user">("user_law_admission"),
                email: "law@example.test",
              },
              session: { activeOrganizationId: organizationId },
              memberRole: sessionMemberRole("owner"),
              orgAIConfig: null,
              orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
              promptCachingEnabled: false,
              managedAIResidency: "eu",
              safeDb: () => panic("This read does not query tenant resources"),
              scopedDb: async (
                read: Parameters<TestDatabase["transaction"]>[0],
              ) => {
                corpusReads += 1;
                return await db.transaction(read);
              },
            }),
          );
          expect(accessReads).toBe(outcome.enabled ? 1 : 0);
          if (outcome.type === "admitted") {
            expect(corpusReads).toBeGreaterThan(0);
            if (surface === "legislation") {
              expect(result).toMatchObject({
                title: "Admission statute",
                fulltext: STATUTE_WORDING,
              });
            } else {
              expect(result).toMatchObject({
                status: "error",
                code: "decision_not_found",
              });
            }
            return;
          }
          expect(corpusReads).toBe(0);
          expect(result).toMatchObject({
            code: outcome.status,
            response: { code: outcome.type },
          });
        },
      );
    },
  );

  test.each(outcomes)(
    "decision context answers $type with actual public wording",
    async (outcome) => {
      let corpusReads = 0;
      const readDecision = async <T>(
        read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
      ) => {
        corpusReads += 1;
        return await withPublicLawReaderRole(
          db,
          async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
        );
      };
      const result = await buildChatSystemPromptParts({
        activeDecision: { decisionId: textDecisionId },
        activeStatute: undefined,
        activeExternal: undefined,
        activeFile: undefined,
        activeSkillContext: null,
        caseLawDb: Object.assign(readDecision, caseLawPublicReadDb),
        admitLawRead: async (options) =>
          await admitLawReadOrError({
            ...options,
            publicLawEnabled: () => outcome.enabled,
            mayReadPublicLaw: async () =>
              outcome.type === "access_unavailable"
                ? Result.err(
                    new OrganizationAccessReadError({
                      message: "Access unavailable",
                      cause: null,
                    }),
                  )
                : Result.ok(outcome.type === "admitted"),
          }),
        organizationId,
        contextMatterIds: [],
        hasReachableMatter: false,
        offeredToolNamesForSkills: () => new Set(),
        practiceJurisdictions: [],
        refRegistry: createChatRefRegistry(),
        safeDb: asTestRaw<SafeDb>(async () =>
          panic("Law context cannot read tenant data without user context"),
        ),
        messages: [],
        threadId: createSafeId<"chatThread">(),
        toolAvailability: {
          docxEditMode: null,
          templateAuthoring: false,
          webResearch: false,
          folioAgentDocTools: false,
          subagents: false,
        },
        userContext: undefined,
        workspaceId: null,
      });
      if (outcome.type === "admitted") {
        expect(result.unwrap().untrustedSuffix).toContain(DECISION_WORDING);
        expect(result.unwrap().untrustedSuffix).toContain("22 Cdo 100/2026");
        expect(corpusReads).toBeGreaterThan(0);
        return;
      }
      if (!Result.isError(result) || !HandlerError.is(result.error)) {
        panic("Expected typed law refusal");
      }
      expect(result.error.code).toBe(outcome.type);
      expect(result.error.status).toBe(outcome.status);
      expect(corpusReads).toBe(0);
    },
  );
});
