import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { API_FILE_SECURITY_REJECTED_ERROR_CODE } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { agentSkills } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import uploadSkill from "./upload";

/**
 * A skill pack sent as a multipart body passes the same file scan as one
 * finalized through a presigned upload before its bytes are parsed.
 */

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const memberSafeDb = (): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));

const upload = async (file: File) =>
  await uploadSkill.handler(
    createTestHandlerContext<Parameters<typeof uploadSkill.handler>[0]>({
      memberRole: { role: "member" },
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      safeDb: memberSafeDb(),
      body: { scope: "private", file },
    }),
  );

const skillFile = (name: string, body: string) =>
  new File(
    [`---\nname: ${name}\ndescription: Upload scan test.\n---\n\n${body}\n`],
    "SKILL.md",
    { type: "text/markdown" },
  );

const installedCount = async (name: string) =>
  await testDb.$count(
    agentSkills,
    and(
      eq(agentSkills.organizationId, ids.orgA),
      eq(agentSkills.userId, ids.userA1),
      eq(agentSkills.slug, name),
    ),
  );

test("a pack the file scan rejects is refused and nothing is installed", async () => {
  const name = `scan-refused-${Bun.randomUUIDv7().slice(-8)}`;

  const result = await upload(
    skillFile(
      name,
      '<!DOCTYPE skill [<!ENTITY secret SYSTEM "file:///etc/passwd">]>',
    ),
  );

  if (!("code" in result)) {
    throw new TypeError("expected the upload to be refused");
  }
  expect(result.code).toBe(422);
  expect(result.response).toMatchObject({
    code: API_FILE_SECURITY_REJECTED_ERROR_CODE,
  });
  expect(await installedCount(name)).toBe(0);
});

test("a clean pack is installed", async () => {
  const name = `scan-clean-${Bun.randomUUIDv7().slice(-8)}`;

  const result = await upload(skillFile(name, "Follow the checklist."));

  expect("code" in result).toBe(false);
  expect(await installedCount(name)).toBe(1);
});
