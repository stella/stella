import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { fileComparisonUploads } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  createScopedQuery,
  getTestDb,
  releaseTestDb,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const organizationA = mintAuthProviderId<"organization">();
const organizationB = mintAuthProviderId<"organization">();
const userA = mintAuthProviderId<"user">();
const userB = mintAuthProviderId<"user">();

const stagedByUserA = createSafeId<"fileComparisonUpload">();

/** A driver wraps the database's own message; read the whole chain. */
const causeChainText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
};

const inputRow = ({
  id,
  organizationId,
  userId,
}: {
  id: SafeId<"fileComparisonUpload">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}) => ({
  id,
  organizationId,
  userId,
  kind: "input" as const,
  declaredName: "Draft.docx",
  declaredSize: 2048,
  declaredSha256: "a".repeat(64),
  status: "pending" as const,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
});

let testDb: TestDatabase;
let scopedQuery: ReturnType<typeof createScopedQuery>;

beforeAll(async () => {
  testDb = await getTestDb();
  scopedQuery = createScopedQuery(testDb);
  for (const [organizationId, userId, label] of [
    [organizationA, userA, "a"],
    [organizationB, userB, "b"],
  ] as const) {
    await testDb.insert(user).values({
      id: userId,
      name: `Comparer ${label}`,
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await testDb.insert(organization).values({
      id: organizationId,
      name: `Comparer organization ${label}`,
      slug: `comparer-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
  }
  await testDb.insert(fileComparisonUploads).values(
    inputRow({
      id: stagedByUserA,
      organizationId: organizationA,
      userId: userA,
    }),
  );
});

afterAll(async () => {
  await releaseTestDb();
});

describe("file_comparison_uploads row-level security", () => {
  test("the member who staged the file sees their own row", async () => {
    const rows = await scopedQuery(
      [],
      organizationA,
      async (tx) =>
        await tx
          .select({ id: fileComparisonUploads.id })
          .from(fileComparisonUploads)
          .where(eq(fileComparisonUploads.id, stagedByUserA)),
      userA,
    );

    expect(rows.map(({ id }) => id)).toEqual([stagedByUserA]);
  });

  test("another member of the same firm sees nothing", async () => {
    const rows = await scopedQuery(
      [],
      organizationA,
      async (tx) =>
        await tx
          .select({ id: fileComparisonUploads.id })
          .from(fileComparisonUploads),
      userB,
    );

    expect(rows).toEqual([]);
  });

  test("the same member in another firm's session sees nothing", async () => {
    const rows = await scopedQuery(
      [],
      organizationB,
      async (tx) =>
        await tx
          .select({ id: fileComparisonUploads.id })
          .from(fileComparisonUploads),
      userA,
    );

    expect(rows).toEqual([]);
  });

  test("a row cannot be staged in another member's name", async () => {
    const written = await Result.tryPromise(
      async () =>
        await scopedQuery(
          [],
          organizationA,
          async (tx) =>
            await tx.insert(fileComparisonUploads).values(
              inputRow({
                id: createSafeId<"fileComparisonUpload">(),
                organizationId: organizationA,
                userId: userB,
              }),
            ),
          userA,
        ),
    );

    expect(Result.isError(written)).toBe(true);
  });

  test("a redline row carries no checksum and an input row must", async () => {
    const written = await Result.tryPromise(
      async () =>
        await testDb.execute(sql`
          INSERT INTO file_comparison_uploads
            (id, organization_id, user_id, kind, declared_name, declared_size,
             declared_sha256, status, expires_at)
          VALUES
            (${Bun.randomUUIDv7()}, ${organizationA}, ${userA}, 'redline',
             'Draft redline.docx', 10, ${"a".repeat(64)}, 'ready', now())
        `),
    );

    expect(Result.isError(written)).toBe(true);
    expect(
      causeChainText(Result.isError(written) ? written.error : null),
    ).toContain("file_comparison_uploads_sha256_check");
  });
});
