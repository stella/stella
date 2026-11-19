import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { agentSkillResources, agentSkills } from "@/api/db/schema";
import exportSkill from "@/api/handlers/skills/export";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { parseUploadedSkillPackage } from "@/api/lib/skills/skill-package";
import {
  handlerFailure,
  insertTestSkill,
  skillHandlerContext,
} from "@/api/tests/helpers/agent-skill-db";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await testDb
    .delete(agentSkills)
    .where(
      and(
        eq(agentSkills.organizationId, ids.orgA),
        inArray(agentSkills.userId, [ids.userA1, ids.userA2]),
      ),
    );
  await releaseRlsFixture();
});

const exportAs = async (
  userId: SafeId<"user">,
  skillId: SafeId<"agentSkill">,
) =>
  await exportSkill.handler(
    skillHandlerContext<Parameters<typeof exportSkill.handler>[0]>({
      organizationId: ids.orgA,
      params: { skillId },
      testDb,
      userId,
    }),
  );

describe("skills.export", () => {
  test("downloads an Agent Skills archive that installs back to the same skill", async () => {
    const skillId = await insertTestSkill(testDb, {
      body: "Read `references/checklist.md`.",
      description: "Reviews closing files.",
      name: "Closing review",
      organizationId: ids.orgA,
      slug: `closing-review-${Bun.randomUUIDv7()}`,
      userId: ids.userA1,
    });
    await testDb.insert(agentSkillResources).values({
      content: "Check one.",
      organizationId: ids.orgA,
      path: "references/checklist.md",
      sizeBytes: 10,
      skillId,
    });

    const response = await exportAs(ids.userA1, skillId);
    if (!(response instanceof Response)) {
      return panic(`Expected an archive, got ${JSON.stringify(response)}`);
    }
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(
      "closing-review.zip",
    );

    const imported = await parseUploadedSkillPackage(
      testScannedFile({
        bytes: await response.arrayBuffer(),
        mimeType: "application/zip",
        path: "closing-review.zip",
      }),
    );
    if (imported.isErr()) {
      return panic(`The archive did not import: ${imported.error.message}`);
    }
    expect(imported.value).toMatchObject({
      body: "Read `references/checklist.md`.",
      description: "Reviews closing files.",
      name: "closing-review",
    });
    expect(
      imported.value.resources.map(({ content, path }) => ({ content, path })),
    ).toEqual([{ content: "Check one.", path: "references/checklist.md" }]);
  });

  test("refuses a skill the caller cannot read", async () => {
    const skillId = await insertTestSkill(testDb, {
      organizationId: ids.orgA,
      userId: ids.userA1,
    });

    expect(handlerFailure(await exportAs(ids.userA2, skillId))?.code).toBe(404);
    expect(
      handlerFailure(
        await exportAs(
          ids.userA2,
          toSafeId<"agentSkill">("44444444-4444-4444-8444-444444444444"),
        ),
      )?.code,
    ).toBe(404);
  });
});
