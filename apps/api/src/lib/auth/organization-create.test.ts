import { APIError } from "better-auth/api";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import { createOrganizationForAccount } from "@/api/db/root";
import type { accountAuditLogs } from "@/api/db/schema";
import { organizationCreationRequests } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const USER_ID = toSafeId<"user">("creation-error-user");
const REQUEST_KEY = "creation-error-key";
const NAME = "Example firm";

type Receipt = typeof organizationCreationRequests.$inferSelect;

const creationFixture = () => {
  const receipts = new Map<string, Receipt>();
  const audits: (typeof accountAuditLogs.$inferInsert)[] = [];
  const matchingKey = (condition: SQL | undefined) => {
    if (condition === undefined) {
      return panic("Receipt access requires an account and key predicate");
    }
    const { params } = new PgDialect().sqlToQuery(condition);
    expect(params).toEqual([USER_ID, REQUEST_KEY]);
    return REQUEST_KEY;
  };
  const transaction = asTestRaw<Transaction>({
    rollback: () => panic("The fixture rolls back by rejecting the callback"),
    insert: (
      table: typeof organizationCreationRequests | typeof accountAuditLogs,
    ) => {
      if (table === organizationCreationRequests) {
        return {
          values: (
            value: typeof organizationCreationRequests.$inferInsert,
          ) => ({
            onConflictDoNothing: () => ({
              returning: async () => {
                if (receipts.has(value.key)) {
                  return [];
                }
                receipts.set(value.key, {
                  ...value,
                  organizationId: null,
                  name: null,
                  slug: null,
                  createdAt: new Date("2026-10-30T12:00:00Z"),
                });
                return [{ key: value.key }];
              },
            }),
          }),
        };
      }
      return {
        values: async (values: (typeof accountAuditLogs.$inferInsert)[]) => {
          audits.push(...values);
        },
      };
    },
    select: () => ({
      from: () => ({
        where: (condition: SQL) => ({
          limit: async () => {
            const receipt = receipts.get(matchingKey(condition));
            return receipt === undefined ? [] : [receipt];
          },
        }),
      }),
    }),
    delete: () => ({
      where: async (condition: SQL) => {
        receipts.delete(matchingKey(condition));
      },
    }),
    update: () => ({
      set: (result: Pick<Receipt, "organizationId" | "name" | "slug">) => ({
        where: async (condition: SQL) => {
          const key = matchingKey(condition);
          const receipt = receipts.get(key);
          if (receipt === undefined) {
            return panic("Completion requires a claimed receipt");
          }
          receipts.set(key, { ...receipt, ...result });
        },
      }),
    }),
    transaction: async (run: (tx: Transaction) => Promise<unknown>) => {
      const previousReceipts = new Map(receipts);
      const previousAuditCount = audits.length;
      const result = await Result.tryPromise({
        try: async () => await run(asTestRaw<Transaction>({ ...transaction })),
        catch: (cause) => cause,
      });
      if (result.isErr()) {
        receipts.clear();
        for (const [key, receipt] of previousReceipts) {
          receipts.set(key, receipt);
        }
        audits.splice(previousAuditCount);
        throw result.error;
      }
      return result.value;
    },
  });
  const created = (slug: string) => ({
    id: "created-organization",
    name: NAME,
    slug,
  });
  const database = { transaction: transaction.transaction };
  return { database, receipts, audits, created };
};

const slugConflict = (code: string) =>
  new APIError("BAD_REQUEST", { code, message: "Organization already exists" });

describe("organization creation provider refusals", () => {
  test.each(["ORGANIZATION_ALREADY_EXISTS", "ORGANIZATION_SLUG_ALREADY_TAKEN"])(
    "an automatic slug retries the provider conflict %s and succeeds",
    async (code) => {
      const fixture = creationFixture();
      const attemptedSlugs: string[] = [];
      let entropy = 0;
      const result = await createOrganizationForAccount(
        {
          userId: USER_ID,
          evaluation: "none",
          name: NAME,
          idempotencyKey: null,
        },
        {
          database: fixture.database,
          randomBytes: () => new Uint8Array(10).fill(entropy++),
          createOrganization: async ({ body: { slug } }) => {
            attemptedSlugs.push(slug);
            if (attemptedSlugs.length === 1) {
              throw slugConflict(code);
            }
            return fixture.created(slug);
          },
        },
      );
      expect(result).toEqual(
        Result.ok({
          organizationId: "created-organization",
          name: NAME,
          slug: "org-bbbbbbbbbb",
          role: "owner",
        }),
      );
      expect(attemptedSlugs).toEqual(["org-aaaaaaaaaa", "org-bbbbbbbbbb"]);
      expect(entropy).toBe(2);
      for (const slug of attemptedSlugs) {
        expect(slug).toMatch(/^org-[a-z2-7]{10}$/u);
        expect(slug).not.toContain("example");
        expect(slug).not.toContain("firm");
      }
      expect(fixture.audits).toHaveLength(1);
      expect(fixture.audits.at(0)?.eventType).toBe("organization.created");
    },
  );

  test.each(["ORGANIZATION_ALREADY_EXISTS", "ORGANIZATION_SLUG_ALREADY_TAKEN"])(
    "an explicit slug returns a typed conflict for %s",
    async (code) => {
      const fixture = creationFixture();
      const attemptedSlugs: string[] = [];
      const result = await createOrganizationForAccount(
        {
          userId: USER_ID,
          evaluation: "none",
          name: NAME,
          slug: "reserved",
          idempotencyKey: null,
        },
        {
          database: fixture.database,
          randomBytes: () =>
            panic("Explicit slugs must not consume random bytes"),
          createOrganization: async ({ body: { slug } }) => {
            attemptedSlugs.push(slug);
            throw slugConflict(code);
          },
        },
      );
      expect(result.isErr()).toBe(true);
      if (result.isOk()) {
        return panic("An explicit slug conflict must be refused");
      }
      expect(result.error).toBeInstanceOf(HandlerError);
      expect(result.error).toMatchObject({
        status: 409,
        code: "organization_slug_conflict",
      });
      expect(attemptedSlugs).toEqual(["reserved"]);
      expect(fixture.audits).toEqual([]);
    },
  );

  test("a provider 403 returns the documented account refusal", async () => {
    const fixture = creationFixture();
    const result = await createOrganizationForAccount(
      { userId: USER_ID, evaluation: "none", name: NAME, idempotencyKey: null },
      {
        database: fixture.database,
        createOrganization: async () => {
          throw new APIError("FORBIDDEN", {
            message: "Creation is unavailable",
          });
        },
      },
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return panic("A provider refusal must not create an organization");
    }
    expect(result.error).toBeInstanceOf(HandlerError);
    expect(result.error).toMatchObject({
      status: 403,
      code: "account_access_unavailable",
    });
    expect(fixture.audits).toEqual([]);
  });

  test.each([
    {
      error: slugConflict("ORGANIZATION_ALREADY_EXISTS"),
      code: "organization_slug_conflict",
    },
    {
      error: new APIError("FORBIDDEN", { message: "Creation is unavailable" }),
      code: "account_access_unavailable",
    },
  ])(
    "a keyed $code refusal releases its claim so the same request can succeed",
    async ({ error, code }) => {
      const fixture = creationFixture();
      const input = {
        userId: USER_ID,
        evaluation: "none" as const,
        name: NAME,
        slug: "example-firm",
        idempotencyKey: REQUEST_KEY,
      };
      const refused = await createOrganizationForAccount(input, {
        database: fixture.database,
        createOrganization: async () => {
          throw error;
        },
      });
      expect(refused.isErr()).toBe(true);
      if (refused.isOk()) {
        return panic("The provider refusal must reach the caller");
      }
      expect(fixture.receipts.size).toBe(0);
      expect(refused.error).toMatchObject({ code });
      const retried = await createOrganizationForAccount(input, {
        database: fixture.database,
        createOrganization: async ({ body: { slug } }) => fixture.created(slug),
      });
      expect(retried).toEqual(
        Result.ok({
          organizationId: "created-organization",
          name: NAME,
          slug: "example-firm",
          role: "owner",
        }),
      );
      expect(fixture.receipts.get(REQUEST_KEY)?.organizationId).toBe(
        "created-organization",
      );
    },
  );

  test("a failed creation rolls back its receipt and preserves the original cause", async () => {
    const fixture = creationFixture();
    const error = new APIError("INTERNAL_SERVER_ERROR", {
      message: "Creation outcome is uncertain",
    });
    const result = await createOrganizationForAccount(
      {
        userId: USER_ID,
        evaluation: "none",
        name: NAME,
        idempotencyKey: REQUEST_KEY,
      },
      {
        database: fixture.database,
        createOrganization: async () => {
          throw error;
        },
      },
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk() || !HandlerError.is(result.error)) {
      return panic(
        "Unknown creation failures must preserve their original cause",
      );
    }
    expect(result.error.status).toBe(500);
    expect(result.error.message).toBe(
      "Organization creation could not be completed.",
    );
    expect(result.error.cause).toBe(error);
    expect(fixture.receipts.has(REQUEST_KEY)).toBe(false);
    expect(fixture.audits).toEqual([]);
  });
});
