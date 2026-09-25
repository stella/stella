import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { agentSkills } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import type { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { installSkill } from "./install";
import {
  createSkillPackageFetchContext,
  fetchSkillPackageFromUrl,
} from "./skill-package";

let testDb: TestDatabase;
let ids: TestIds;
const skillIds: SafeId<"agentSkill">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  if (skillIds.length > 0) {
    await testDb.delete(agentSkills).where(inArray(agentSkills.id, skillIds));
  }
  await releaseRlsFixture();
});

const serveSkillFile =
  (source: string): typeof safeOutboundFetchBytes =>
  async () =>
    Result.ok({
      body: new TextEncoder().encode(source).buffer,
      headers: new Headers({ "content-type": "text/markdown" }),
      ok: true,
      status: 200,
    });

const fetchPackage = async (url: string, source: string) => {
  const fetched = await fetchSkillPackageFromUrl(
    url,
    createSkillPackageFetchContext(
      { deadlineAt: Date.now() + 30_000, maxRequests: 4 },
      serveSkillFile(source),
    ),
  );
  if (Result.isError(fetched)) {
    return panic(
      `Expected the skill package to parse: ${fetched.error.message}`,
    );
  }
  return fetched.value;
};

describe("installing a skill fetched from a URL", () => {
  test("installing the same URL package again returns the installed skill", async () => {
    const name = `replayed-${Bun.randomUUIDv7().slice(-12)}`;
    const parsed = await fetchPackage(
      `https://skills.example/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Replayed import.\n---\n\nFollow the steps.`,
    );
    const safeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [], ids.orgA, ids.userA1),
    );
    const install = async () =>
      await installSkill({
        memberRole: { role: "owner" },
        origin: "url",
        parsed,
        recordAuditEvent: async () => undefined,
        safeDb,
        scope: "private",
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
      });

    const first = await install();
    if (Result.isError(first)) {
      throw first.error;
    }
    skillIds.push(first.value.id);
    const second = await install();
    if (Result.isError(second)) {
      throw second.error;
    }

    expect(parsed.urlReplayIdentity).toBe("content-hash");
    expect(second.value.id).toBe(first.value.id);
    expect(
      await testDb.$count(
        agentSkills,
        and(
          eq(agentSkills.organizationId, ids.orgA),
          eq(agentSkills.slug, name),
        ),
      ),
    ).toBe(1);
  });

  test("a skill whose stored hash predates the current formula re-imports as unchanged", async () => {
    const name = `stored-hash-${Bun.randomUUIDv7().slice(-12)}`;
    const body = "Follow the stored steps.";
    const parsed = await fetchPackage(
      `https://skills.example/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Stored before the hash covered everything.\n---\n\n${body}`,
    );
    const install = async () =>
      await installSkill({
        memberRole: { role: "owner" },
        origin: "url",
        parsed,
        recordAuditEvent: async () => undefined,
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, [], ids.orgA, ids.userA1),
        ),
        scope: "private",
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
      });
    const first = await install();
    if (Result.isError(first)) {
      throw first.error;
    }
    skillIds.push(first.value.id);
    // A hash of the body alone, as rows written under an earlier formula hold.
    await testDb
      .update(agentSkills)
      .set({
        contentHash: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
      })
      .where(eq(agentSkills.id, first.value.id));

    const second = await install();

    if (Result.isError(second)) {
      throw second.error;
    }
    expect(second.value.id).toBe(first.value.id);
  });
});
