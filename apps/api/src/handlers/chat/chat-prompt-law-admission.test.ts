import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { buildChatSystemPromptParts } from "@/api/handlers/chat/chat-prompt";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  LegislationPublicReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { admitLawReadOrError } from "@/api/lib/usage/law-read-admission";
import { OrganizationAccessReadError } from "@/api/lib/usage/public-law-access";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("org-law-admission");
const contexts = [
  {
    name: "decision",
    activeDecision: { decisionId: createSafeId<"caseLawDecision">() },
    activeStatute: undefined,
  },
  {
    name: "statute",
    activeDecision: undefined,
    activeStatute: { documentId: createSafeId<"legislationDocument">() },
  },
] as const;

const base = () => ({
  activeExternal: undefined,
  activeFile: undefined,
  activeSkillContext: null,
  contextMatterIds: [],
  hasReachableMatter: false,
  offeredToolNamesForSkills: () => new Set<string>(),
  practiceJurisdictions: [],
  refRegistry: createChatRefRegistry(),
  safeDb: asTestRaw<SafeDb>(async () => Result.ok([])),
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

const unavailableAccess = () =>
  Result.err(
    new OrganizationAccessReadError({
      message: "Organization access unavailable",
      cause: new Error("Access store unavailable"),
    }),
  );

for (const context of contexts) {
  describe(`active ${context.name} law admission`, () => {
    for (const refusal of [
      {
        code: "not_entitled",
        status: 403,
        enabled: true,
        access: async () => Result.ok(false),
      },
      {
        code: "missing_scope",
        status: 403,
        enabled: false,
        access: async () =>
          panic("Disabled law cannot read organization access"),
      },
      {
        code: "access_unavailable",
        status: 503,
        enabled: true,
        access: async () => unavailableAccess(),
      },
    ] as const) {
      test(`returns ${refusal.code} before reading corpus or tenant data`, async () => {
        let admissions = 0;
        const result = await buildChatSystemPromptParts({
          ...base(),
          ...context,
          organizationId,
          safeDb: () => panic("Refused context cannot read tenant data"),
          caseLawDb: asTestRaw<CaseLawPublicReadDb>(async () =>
            panic("Refused context cannot read case law"),
          ),
          legislationDb: asTestRaw<LegislationPublicReadDb>(async () =>
            panic("Refused context cannot read legislation"),
          ),
          admitLawRead: async (options) => {
            admissions += 1;
            expect(options.organizationId).toBe(organizationId);
            return await admitLawReadOrError({
              ...options,
              publicLawEnabled: () => refusal.enabled,
              mayReadPublicLaw: refusal.access,
            });
          },
        });
        expect(admissions).toBe(1);
        expect(Result.isError(result)).toBe(true);
        if (!Result.isError(result)) {
          panic("Admission refusal expected");
        }
        expect(HandlerError.is(result.error)).toBe(true);
        if (!HandlerError.is(result.error)) {
          panic("Typed refusal expected");
        }
        expect(result.error.status).toBe(refusal.status);
        expect(result.error.code).toBe(refusal.code);
      });
    }

    test("requires organization context before admission", async () => {
      const result = await buildChatSystemPromptParts({
        ...base(),
        ...context,
        admitLawRead: async () =>
          panic("Missing organization cannot be admitted"),
      });
      if (!Result.isError(result) || !HandlerError.is(result.error)) {
        panic("Missing scope expected");
      }
      expect(result.error.code).toBe("missing_scope");
      expect(result.error.status).toBe(403);
    });

    test("admits the organization before querying its active public law", async () => {
      let admissions = 0;
      let reads = 0;
      const transaction = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
          }),
        }),
      };
      const result = await buildChatSystemPromptParts({
        ...base(),
        ...context,
        organizationId,
        caseLawDb: asTestRaw<CaseLawPublicReadDb>(
          async (
            read: (tx: CaseLawPublicReadTransaction) => Promise<unknown>,
          ) => {
            expect(admissions).toBe(1);
            reads += 1;
            return await read(
              asTestRaw<CaseLawPublicReadTransaction>(transaction),
            );
          },
        ),
        legislationDb: asTestRaw<LegislationPublicReadDb>(
          async (
            read: (tx: LegislationReadTransaction) => Promise<unknown>,
          ) => {
            expect(admissions).toBe(1);
            reads += 1;
            return await read(
              asTestRaw<LegislationReadTransaction>(transaction),
            );
          },
        ),
        admitLawRead: async (options) => {
          admissions += 1;
          return await admitLawReadOrError({
            ...options,
            publicLawEnabled: () => true,
            mayReadPublicLaw: async () => Result.ok(true),
          });
        },
      });
      expect(Result.isOk(result)).toBe(true);
      expect(admissions).toBe(1);
      expect(reads).toBe(1);
    });
  });
}

test("chat without active public law does not request law admission", async () => {
  const result = await buildChatSystemPromptParts({
    ...base(),
    activeDecision: undefined,
    activeStatute: undefined,
    admitLawRead: async () =>
      panic("Ordinary chat cannot require law admission"),
  });
  expect(Result.isOk(result)).toBe(true);
});
