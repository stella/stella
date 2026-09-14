import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { legalReaderAnnotations } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
// One id, two corpora: nothing stops a decision and a consolidated statute
// from being minted with the same UUID, so the discriminator is what keeps a
// reader's marks on the document they were left on.
const sharedTargetId = Bun.randomUUIDv7();

const mark = (targetType: "decision" | "statute", quote: string) => ({
  id: createSafeId<"legalReaderAnnotation">(),
  organizationId,
  userId,
  targetType,
  targetId: sharedTargetId,
  kind: "highlight" as const,
  visibility: "private" as const,
  color: "yellow" as const,
  style: "highlight" as const,
  blockAnchorId: "p-1",
  startOffset: 0,
  endOffset: quote.length,
  quote,
});

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

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.insert(user).values({
    id: userId,
    name: "Reader",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Reader organization",
    slug: `reader-${organizationId}`,
    createdAt: new Date(),
  });
  await testDb.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await releaseTestDb();
});

describe("legal reader annotations", () => {
  test("tells two corpora sharing one id apart", async () => {
    await testDb
      .insert(legalReaderAnnotations)
      .values([
        mark("decision", "as the court held"),
        mark("statute", "§ 2079"),
      ]);

    const onStatute = await testDb
      .select({ quote: legalReaderAnnotations.quote })
      .from(legalReaderAnnotations)
      .where(
        and(
          eq(legalReaderAnnotations.organizationId, organizationId),
          eq(legalReaderAnnotations.targetType, "statute"),
          eq(legalReaderAnnotations.targetId, sharedTargetId),
        ),
      );

    expect(onStatute.map((row) => row.quote)).toEqual(["§ 2079"]);
  });

  test("refuses a corpus the schema does not name", async () => {
    const written = await Result.tryPromise(
      async () =>
        await testDb.execute(sql`
          INSERT INTO legal_reader_annotations
            (id, organization_id, user_id, target_type, target_id, kind,
             visibility, color, style, block_anchor_id, start_offset,
             end_offset, quote)
          VALUES
            (${Bun.randomUUIDv7()}, ${organizationId}, ${userId}, 'encyclopaedia',
             ${Bun.randomUUIDv7()}, 'highlight', 'private', 'yellow', 'highlight',
             'p-1', 0, 5, 'words')
        `),
    );

    expect(Result.isError(written)).toBe(true);
    expect(
      causeChainText(Result.isError(written) ? written.error : null),
    ).toContain("legal_reader_annotations_target_type_values");
  });
});
