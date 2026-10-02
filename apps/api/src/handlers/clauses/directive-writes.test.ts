import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import { CLAUSE_DIRECTIVES_INVALID_CODE } from "@stll/api-contract";

import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createClauseHandler } from "./create";
import { importHandler } from "./import";
import { updateClauseHandler } from "./update";
import { createVariantHandler, updateVariantHandler } from "./variants";
import restoreClauseVersion from "./versions/restore";

const organizationId = toSafeId<"organization">(
  "00000000-0000-4000-8000-000000000001",
);
const userId = toSafeId<"user">("00000000-0000-4000-8000-000000000002");
const clauseId = toSafeId<"clause">("00000000-0000-4000-8000-000000000003");
const variantId = toSafeId<"clauseVariant">(
  "00000000-0000-4000-8000-000000000004",
);
const malformed = [{ text: "{% if enabled %}" }, { text: "Unclosed" }];
const recordAuditEvent = async () => {
  await Promise.resolve();
};

for (const operation of [
  "create",
  "update",
  "variant-create",
  "variant-update",
  "json-import",
  "json-variant-import",
  "csv-import",
] as const) {
  test(`${operation} refuses an unbalanced clause before writing`, async () => {
    const { safeDb, getCallCount } = createScopedDbMock({
      $count: async () => 0,
    });
    const common = { safeDb, organizationId, recordAuditEvent };
    const result = await Result.gen(async function* () {
      switch (operation) {
        case "create":
          return yield* createClauseHandler({
            ...common,
            userId,
            body: { title: "Terms", body: malformed },
          });
        case "update":
          return yield* updateClauseHandler({
            ...common,
            clauseId,
            body: { body: malformed },
          });
        case "variant-create":
          return yield* createVariantHandler({
            ...common,
            clauseId,
            body: { label: "Alternative", body: malformed },
          });
        case "variant-update":
          return yield* updateVariantHandler({
            ...common,
            clauseId,
            variantId,
            body: { body: malformed },
          });
        case "json-import":
        case "json-variant-import":
          return yield* importHandler({
            ...common,
            userId,
            body: {
              file: new File(
                [
                  JSON.stringify({
                    version: 1,
                    exportedAt: "2026-10-03",
                    clauses: [
                      {
                        title: "Terms",
                        body:
                          operation === "json-import"
                            ? malformed
                            : [{ text: "Valid" }],
                        variants:
                          operation === "json-variant-import"
                            ? [{ label: "Alternative", body: malformed }]
                            : [],
                      },
                    ],
                  }),
                ],
                "clauses.json",
              ),
            },
          });
        case "csv-import":
          return yield* importHandler({
            ...common,
            userId,
            body: {
              file: new File(
                [
                  'slug,title,body,tags\nterms,Terms,"{% if enabled %}\nUnclosed",',
                ],
                "clauses.csv",
              ),
            },
          });
        default:
          operation satisfies never;
          return panic("Unhandled clause write test operation");
      }
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      if (!HandlerError.is(result.error)) {
        panic("Expected typed clause refusal");
      }
      expect(result.error.status).toBe(422);
      expect(result.error.code).toBe(CLAUSE_DIRECTIVES_INVALID_CODE);
      expect(result.error.issues?.at(0)?.path).toBe("body.0");
    }
    expect(getCallCount()).toBe(operation === "csv-import" ? 1 : 0);
  });
}

test("version restore refuses malformed stored directives before copying the body", async () => {
  const versionId = toSafeId<"clauseVersion">(
    "00000000-0000-4000-8000-000000000005",
  );
  const { safeDb, scopedDb, getCallCount } = createScopedDbMock({
    query: {
      clauses: {
        findFirst: async () => ({
          id: clauseId,
          title: "Terms",
          description: null,
          currentVersion: 3,
        }),
      },
      clauseVersions: {
        findFirst: async () => ({ id: versionId, version: 1, body: malformed }),
      },
    },
  });
  const result = await restoreClauseVersion.handler(
    asTestRaw<Parameters<typeof restoreClauseVersion.handler>[0]>({
      safeDb,
      scopedDb,
      session: { activeOrganizationId: organizationId },
      user: { id: userId, email: "owner@example.test" },
      memberRole: sessionMemberRole("owner"),
      params: { clauseId, versionId },
      request: new Request("https://api.example.test/clauses/versions/restore"),
      recordAuditEvent,
      createAuditRecorder: () => recordAuditEvent,
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu",
    }),
  );
  expect(result).toMatchObject({
    code: 422,
    response: {
      code: CLAUSE_DIRECTIVES_INVALID_CODE,
      hint: expect.stringContaining("save_clause"),
      issues: [
        { path: "body.0", message: expect.stringContaining("Unclosed") },
      ],
    },
  });
  expect(getCallCount()).toBe(2);
});

test("snapshotVersion without a body does not copy a malformed working body into history", async () => {
  const writes: Record<string, unknown>[] = [];
  const { safeDb, getCallCount } = createScopedDbMock({
    query: {
      clauses: {
        findFirst: async () => ({
          id: clauseId,
          title: "Terms",
          description: null,
          usageNotes: null,
          language: null,
          categoryId: null,
          metadata: null,
          body: malformed,
          currentVersion: 3,
        }),
      },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        writes.push(values);
        return {
          where: () => ({
            returning: async () => [
              {
                id: clauseId,
                title: "Terms",
                categoryId: null,
                currentVersion: 3,
                updatedAt: new Date("2026-10-03"),
              },
            ],
          }),
        };
      },
    }),
    insert: () => panic("A request without a body must not insert a snapshot"),
  });
  const result = await Result.gen(() =>
    updateClauseHandler({
      safeDb,
      organizationId,
      clauseId,
      recordAuditEvent,
      body: { snapshotVersion: true },
    }),
  );
  expect(Result.isError(result)).toBe(false);
  expect(writes).toHaveLength(1);
  expect(writes.at(0)).not.toHaveProperty("body");
  expect(writes.at(0)).not.toHaveProperty("currentVersion");
  expect(getCallCount()).toBe(2);
});
