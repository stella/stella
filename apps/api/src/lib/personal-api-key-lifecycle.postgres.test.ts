import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { apikey, member, organization, user } from "@/api/db/auth-schema";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import {
  createPersonalApiKey,
  listPersonalApiKeys,
} from "@/api/lib/personal-api-key-lifecycle";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgres) {
  describe.skip("personal key concurrency (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {});
  });
} else {
  describe("personal key concurrency (postgres)", () => {
    test("parallel mints cannot exceed five active keys for the same member", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient();
        const { db: secondDb } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const recordAuditEvent = createBackgroundAuditRecorder({
          organizationId,
          userId,
          workspaceId: null,
          execution: {
            performer: { type: "user", id: userId },
            trigger: {
              type: "system",
              source: "personal_key_concurrency_test",
            },
          },
        });
        await firstDb.insert(user).values({
          id: userId,
          name: "Fixture member",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await firstDb.insert(organization).values({
          id: organizationId,
          name: "Key concurrency fixture",
          slug: organizationId,
          createdAt: new Date(),
        });
        await firstDb.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        });
        try {
          const results = await Promise.all(
            Array.from({ length: 8 }, (_, index) =>
              createPersonalApiKey({
                name: "Parallel key",
                organizationId,
                userId,
                recordAuditEvent,
                database: index % 2 === 0 ? firstDb : secondDb,
              }),
            ),
          );
          expect(results.filter((result) => result.isOk())).toHaveLength(5);
          expect(results.filter((result) => result.isErr())).toHaveLength(3);
          for (const result of results) {
            if (result.isErr()) {
              expect(result.error.status).toBe(409);
            }
          }
          const page = await listPersonalApiKeys(
            { organizationId, userId, access: "own", limit: 20 },
            firstDb,
          );
          expect(page.items.filter((key) => key.enabled)).toHaveLength(5);
          const ids = results.flatMap((result) =>
            result.isOk() ? [result.value.id] : [],
          );
          if (ids.length !== 5) {
            panic("All successful mints must have persisted ids");
          }
          expect(
            await firstDb.select().from(apikey).where(inArray(apikey.id, ids)),
          ).toHaveLength(5);
        } finally {
          await firstDb.delete(apikey).where(eq(apikey.referenceId, userId));
          await firstDb
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await firstDb.delete(user).where(eq(user.id, userId));
        }
      });
    });
  });
}
