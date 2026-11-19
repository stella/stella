import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { SKILL_PACKAGE_REFUSAL_CODE } from "@stll/api-contract";
import { ZipArchive } from "@stll/docx-core/zip";
import { SKILL_PACKAGE_LIMITS } from "@stll/skills/format";
import { buildSkillPackage } from "@stll/skills/package";

import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { SKILL_PACKAGE_SIZE_CONSTRAINT } from "@/api/lib/db/constraint-refusals";
import { escapeLike } from "@/api/lib/escape-like";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  createScopedQuery,
  TestDatabase,
} from "@/api/tests/security/test-utils";

import createSkillResource from "./resources/create";
import uploadSkill from "./upload";

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const memberSafeDb = (): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));

const handlerContext = <T>(fields: object) =>
  createTestHandlerContext<T>({
    scopedDb: NO_DB,
    audit: auditRecorderDouble(),
    memberRole: sessionMemberRole("member"),
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    safeDb: memberSafeDb(),
    ...fields,
  });

const upload = async (file: File) =>
  await uploadSkill.handler(
    handlerContext<Parameters<typeof uploadSkill.handler>[0]>({
      body: { scope: "private", file },
    }),
  );

const packageFile = async ({
  command,
  slug,
}: {
  command: string | null;
  slug: string;
}) => {
  const zip = new ZipArchive();
  for (const entry of buildSkillPackage({
    command,
    displayName: "Contract review",
    resources: [
      {
        bytes: new TextEncoder().encode("- parties\n"),
        path: "references/checklist.md",
      },
    ],
    skillMd: `---\nname: "${slug}"\ndescription: "Package import test."\n---\n\nRead \`references/checklist.md\`.\n`,
    slug,
  })) {
    zip.set(entry.path, entry.bytes);
  }
  return new File([(await zip.generate()).buffer], `${slug}.skill`);
};

const storedSkills = async (slugPrefix: string) =>
  await testDb
    .select({
      command: agentSkills.command,
      name: agentSkills.name,
      slug: agentSkills.slug,
    })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.organizationId, ids.orgA),
        eq(agentSkills.userId, ids.userA1),
        sql`${agentSkills.slug} LIKE ${`${escapeLike(slugPrefix)}%`}`,
      ),
    )
    .orderBy(agentSkills.createdAt);

describe("skill package import", () => {
  test("restores the display name and command, and a second import lands as a copy", async () => {
    const slug = `package-${Bun.randomUUIDv7().slice(-8)}`;
    const command = `cmd${Bun.randomUUIDv7().slice(-8)}`;

    const first = await upload(await packageFile({ command, slug }));
    const second = await upload(await packageFile({ command, slug }));

    expect("code" in first || "code" in second).toBe(false);
    expect(await storedSkills(slug)).toEqual([
      { command, name: "Contract review", slug },
      // The copy keeps the name; the command stays with the skill holding it.
      { command: null, name: "Contract review", slug: `${slug}-2` },
    ]);
  });

  test("a package without a command imports without one", async () => {
    const slug = `package-${Bun.randomUUIDv7().slice(-8)}`;

    const result = await upload(await packageFile({ command: null, slug }));

    expect("code" in result).toBe(false);
    expect(await storedSkills(slug)).toEqual([
      { command: null, name: "Contract review", slug },
    ]);
  });
});

describe("skill package size", () => {
  const insertSkill = async () => {
    const slug = `size-${Bun.randomUUIDv7().slice(-8)}`;
    const result = await upload(await packageFile({ command: null, slug }));
    if ("code" in result) {
      throw new TypeError("expected the package to install");
    }
    return result.id;
  };

  // Stands in for stored bytes: the guard sums the recorded sizes.
  const recordFile = async ({
    sizeBytes,
    skillId,
  }: {
    sizeBytes: number;
    skillId: string;
  }) =>
    await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) => {
        await tx.insert(agentSkillResources).values({
          content: "x",
          organizationId: ids.orgA,
          path: `references/${Bun.randomUUIDv7()}.md`,
          sizeBytes,
          skillId: asTestRaw(skillId),
        });
      },
      ids.userA1,
    );

  const tryRecordFile = async (options: Parameters<typeof recordFile>[0]) => {
    const written = await Result.tryPromise(
      async () => await recordFile(options),
    );
    return Result.isError(written) ? written.error.cause : null;
  };

  const storedBytes = async (skillId: string) =>
    (
      await testDb
        .select({ sizeBytes: agentSkillResources.sizeBytes })
        .from(agentSkillResources)
        .where(eq(agentSkillResources.skillId, asTestRaw(skillId)))
    ).reduce((sum, { sizeBytes }) => sum + sizeBytes, 0);

  test("a skill's files fill the package limit exactly and not one byte past it", async () => {
    const skillId = await insertSkill();
    const remaining =
      SKILL_PACKAGE_LIMITS.packageFilesMaxBytes - (await storedBytes(skillId));

    expect(await tryRecordFile({ sizeBytes: remaining, skillId })).toBeNull();
    const refused = await tryRecordFile({ sizeBytes: 1, skillId });

    expect(
      isPgConstraintError(
        refused,
        PG_ERROR.CHECK_VIOLATION,
        SKILL_PACKAGE_SIZE_CONSTRAINT,
      ),
    ).toBe(true);
    expect(await storedBytes(skillId)).toBe(
      SKILL_PACKAGE_LIMITS.packageFilesMaxBytes,
    );
  });

  test("a write through the API past the limit is a 413 the caller can act on", async () => {
    const skillId = await insertSkill();
    const remaining =
      SKILL_PACKAGE_LIMITS.packageFilesMaxBytes - (await storedBytes(skillId));
    await recordFile({ sizeBytes: remaining - 2, skillId });

    const result = await createSkillResource.handler(
      handlerContext<Parameters<typeof createSkillResource.handler>[0]>({
        body: { content: "abc", path: "references/over.md" },
        params: { skillId },
      }),
    );

    if (!("code" in result)) {
      throw new TypeError("expected the write to be refused");
    }
    expect(result.code).toBe(413);
    expect(result.response).toMatchObject({
      code: SKILL_PACKAGE_REFUSAL_CODE.tooLarge,
    });
  });
});
