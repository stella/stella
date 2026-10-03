import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import { CLAUSE_DIRECTIVES_INVALID_CODE } from "@stll/api-contract";

import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createClauseHandler } from "./create";
import { importHandler } from "./import";
import { updateClauseHandler } from "./update";
import { createVariantHandler, updateVariantHandler } from "./variants";

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
            body: { body: malformed, snapshotVersion: true },
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
      if (operation === "csv-import") {
        expect(result.error.message).toContain("Row 2 (Terms)");
      }
    }
    expect(getCallCount()).toBe(operation === "csv-import" ? 1 : 0);
  });
}

test("CSV import validates every row before any clause is written", async () => {
  const { safeDb, getCallCount } = createScopedDbMock({
    $count: async () => 0,
  });
  const result = await Result.gen(() =>
    importHandler({
      safeDb,
      organizationId,
      userId,
      body: {
        file: new File(
          [
            'slug,title,body,tags\nvalid,Valid,Ordinary,\nlegacy,Legacy,"{% if enabled %}",',
          ],
          "clauses.csv",
        ),
      },
      recordAuditEvent,
    }),
  );
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toMatchObject({
      status: 422,
      code: CLAUSE_DIRECTIVES_INVALID_CODE,
      message: expect.stringContaining("Row 3 (Legacy)"),
    });
  }
  expect(getCallCount()).toBe(1);
});
