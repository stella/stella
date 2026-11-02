import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import { fileComparisonUploads } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { FILE_COMPARISON_ORGANIZATION_OUTSTANDING_BYTE_LIMIT } from "@/api/lib/uploads/file-comparison/uploads";
import { reserveFileComparisonInputs } from "@/api/mcp/file-comparison-prepare-tool";
import type { PrepareFileComparisonDependencies } from "@/api/mcp/file-comparison-prepare-tool";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const SHA = "a".repeat(64);
// The first member already holds all but this many bytes of the organization.
const REMAINING_BYTES = 4096;

const dependencies: PrepareFileComparisonDependencies = {
  presignUploadUrl: async ({ key, contentType, sha256Base64 }) =>
    await Promise.resolve(
      Result.ok({
        url: `https://s3.example/${key}`,
        headers: {
          "content-type": contentType,
          "content-length": "1",
          "x-amz-checksum-sha256": sha256Base64,
          "x-amz-sdk-checksum-algorithm": "SHA256" as const,
        },
      }),
    ),
};

const contextFor = (
  db: GatedTestDb,
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) =>
  asTestRaw<AuthorizedMcpRequestContext>({
    grantedScopes: ["stella:documents_write"],
    memberRole: "owner",
    organizationId,
    recordAuditEvent: async () => {
      await Promise.resolve();
    },
    safeDb: createSafeDb(markRlsDatabase(db), [], organizationId, userId),
    userId,
  });

const inputs = (size: number) => ({
  base: { name: "Draft.docx", sha256Hex: SHA, size },
  target: { name: "Revised.docx", sha256Hex: SHA, size },
});

describe.skipIf(!runPostgresTests)(
  "file comparison organization capacity on PostgreSQL",
  () => {
    test("members' reservations count together against the organization limit", async () => {
      await withGatedTestClients(
        databaseUrl ?? panic("PostgreSQL capacity tests require DATABASE_URL"),
        async ({ openClient }) => {
          const { db } = openClient();
          const organizationId = mintAuthProviderId<"organization">();
          const firstUserId = mintAuthProviderId<"user">();
          const secondUserId = mintAuthProviderId<"user">();
          await db.insert(organization).values({
            id: organizationId,
            name: "Comparison capacity",
            slug: organizationId,
            createdAt: new Date(),
          });
          await db.insert(user).values(
            [firstUserId, secondUserId].map((id) => ({
              id,
              name: "Comparison member",
              email: `${id}@example.test`,
            })),
          );
          try {
            await db.insert(fileComparisonUploads).values({
              id: createSafeId<"fileComparisonUpload">(),
              organizationId,
              userId: firstUserId,
              kind: "input",
              declaredName: "Held.docx",
              declaredSize:
                FILE_COMPARISON_ORGANIZATION_OUTSTANDING_BYTE_LIMIT -
                REMAINING_BYTES,
              declaredSha256: SHA,
              status: "pending",
              expiresAt: new Date(Date.now() + 3_600_000),
            });
            const context = contextFor(db, organizationId, secondUserId);
            // Row policies hide the first member's reservation from the second.
            const visible = await context.safeDb(
              async (tx) =>
                await tx
                  .select({ id: fileComparisonUploads.id })
                  .from(fileComparisonUploads),
            );
            expect(Result.isOk(visible) ? visible.value : null).toEqual([]);

            const fits = await reserveFileComparisonInputs({
              context,
              dependencies,
              ...inputs(REMAINING_BYTES / 4),
            });
            expect(Result.isOk(fits)).toBe(true);

            const exceeds = await reserveFileComparisonInputs({
              context,
              dependencies,
              ...inputs(REMAINING_BYTES / 2),
            });
            const refusal = Result.isError(exceeds) ? exceeds.error : null;
            expect(refusal).toMatchObject({
              status: "error",
              error: { code: "rate_limited", type: "structured" },
            });
            const reserved = await db
              .select({ size: fileComparisonUploads.declaredSize })
              .from(fileComparisonUploads)
              .where(eq(fileComparisonUploads.userId, secondUserId));
            expect(reserved).toEqual([
              { size: REMAINING_BYTES / 4 },
              { size: REMAINING_BYTES / 4 },
            ]);
          } finally {
            await db
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await db
              .delete(user)
              .where(inArray(user.id, [firstUserId, secondUserId]));
          }
        },
      );
    });
  },
);
