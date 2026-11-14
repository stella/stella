import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeId } from "@/api/lib/branded-types";
import {
  upsertFieldContentSchema,
  writeFieldValue,
} from "@/api/lib/fields/write-field";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

describe("upsert field content schema", () => {
  test.each([
    [{ version: 1, type: "text", value: "Clause 4" }, true],
    [{ version: 1, type: "date", value: "2026-02-28" }, true],
    [{ version: 1, type: "date", value: "2026-02-30" }, false],
    [{ version: 1, type: "date", value: "22/10/2026" }, false],
    [{ version: 1, type: "int", value: 42, currency: null }, true],
    [{ version: 1, type: "int", value: 4.2, currency: null }, false],
    [{ version: 1, type: "int", value: 42, currency: "usd" }, true],
    [{ version: 1, type: "money", amountCents: 1250, currency: "USD" }, true],
    [{ version: 1, type: "money", amountCents: 12.5, currency: "USD" }, false],
    [{ version: 1, type: "money", amountCents: 1250, currency: "US" }, false],
    [{ version: 1, type: "single-select", value: null }, true],
    [{ version: 1, type: "single-select", value: ["Open"] }, false],
    [{ version: 1, type: "multi-select", value: ["Open", "Closed"] }, true],
    [{ version: 1, type: "multi-select", value: [""] }, false],
  ] as const)("validates typed field value %#", (content, accepted) => {
    expect(v.is(upsertFieldContentSchema, content)).toBe(accepted);
  });

  test("accepts exactly the empty person sentinel used to clear a cell", () => {
    expect(
      v.is(upsertFieldContentSchema, {
        version: 1,
        type: "person",
        userId: null,
        name: "",
        image: null,
      }),
    ).toBe(true);
    expect(
      v.is(upsertFieldContentSchema, {
        version: 1,
        type: "person",
        userId: "user-1",
        name: "",
        image: null,
      }),
    ).toBe(false);
  });

  test("keeps non-empty person assignments valid", () => {
    expect(
      v.is(upsertFieldContentSchema, {
        version: 1,
        type: "person",
        userId: "user-1",
        name: "Anna Nováková",
        image: "https://example.test/anna.jpg",
      }),
    ).toBe(true);
  });

  test("refuses a syntactically ISO date that is not a calendar date", async () => {
    let databaseCalls = 0;
    const safeDb = asTestRaw<SafeDb>(async (run: (tx: unknown) => unknown) => {
      databaseCalls += 1;
      return Result.ok(
        await run({
          query: {
            properties: {
              findFirst: async () => ({
                id: createSafeId<"property">(),
                content: { version: 1, type: "date" },
              }),
            },
          },
        }),
      );
    });

    const result = await Result.gen(() =>
      writeFieldValue({
        safeDb,
        authority: sessionMemberRole("owner"),
        workspaceId: createSafeId<"workspace">(),
        userId: mintAuthProviderId<"user">(),
        recordAuditEvent: async () => undefined,
        entityId: createSafeId<"entity">(),
        propertyId: createSafeId<"property">(),
        content: { version: 1, type: "date", value: "2026-02-30" },
      }),
    );

    expect(Result.isError(result) && result.error).toMatchObject({
      status: 400,
      message: "Invalid calendar date",
    });
    expect(databaseCalls).toBe(1);
  });
});
