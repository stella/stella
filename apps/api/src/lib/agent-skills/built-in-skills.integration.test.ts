import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { listSkillMetadata, loadSkill } from "@stll/skills";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { agentSkills } from "@/api/db/schema";
import { resolveRequestedSkills } from "@/api/lib/agent-skills/requested-skills";
import {
  listAvailableChatSkillMetadata,
  loadAvailableChatSkills,
  readAvailableChatSkillResource,
  resolveActiveSkillContext,
} from "@/api/lib/agent-skills/skills";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * Every skill shipped in `packages/skills/skills/` reaches each chat entry
 * point with no `agent_skills` row: the catalog, an explicit reference, and an
 * active-skill pick by name. The cases run over whatever ships, so a new
 * built-in is covered without a test edit.
 */

const testId = <T extends SafeIdType>() => toSafeId<T>(Bun.randomUUIDv7());

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = async (callback) =>
    await Result.tryPromise(
      async () => await callback(asTestRaw<Transaction>(testDb)),
    );
});

afterAll(async () => {
  await releaseRlsFixture();
});

const BUILT_IN_NAMES = listSkillMetadata().map(({ name }) => name);

const unwrap = <T, E extends Error>(result: Result<T, E>): T => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

// userB1 belongs to the second organization, which no other suite gives
// skill rows, so every built-in is unshadowed there.
const callerWithoutRows = () => ({
  organizationId: ids.orgB,
  safeDb,
  userId: ids.userB1,
});

describe("shipped built-in skills in chat", () => {
  test("at least one built-in ships", () => {
    expect(BUILT_IN_NAMES.length).toBeGreaterThan(0);
  });

  test.each(BUILT_IN_NAMES)(
    "%s is in the catalog with no row",
    async (name) => {
      const catalog = unwrap(
        await listAvailableChatSkillMetadata(callerWithoutRows()),
      );

      expect(catalog.find((skill) => skill.name === name)).toMatchObject({
        name,
        source: "built-in",
      });
    },
  );

  test.each(BUILT_IN_NAMES)(
    "%s preloads from an explicit reference and is audited under its slug",
    async (name) => {
      const context = callerWithoutRows();
      const auditEvents: AuditEvent[] = [];
      const recordAuditEvent: AuditRecorder = async (_tx, event) => {
        auditEvents.push(...(Array.isArray(event) ? event : [event]));
      };

      const requested = unwrap(
        await resolveRequestedSkills({
          ...context,
          catalog: unwrap(await listAvailableChatSkillMetadata(context)),
          messageText: `Use [${name}](#stella-skill-ref=${name}).`,
          recordAuditEvent,
        }),
      );

      expect(requested.unavailable).toEqual([]);
      expect(requested.loaded).toHaveLength(1);
      expect(requested.loaded.at(0)).toMatchObject({
        body: loadSkill(name).body,
        name,
        source: "built-in",
      });
      expect(auditEvents).toEqual([
        expect.objectContaining({
          resourceId: name,
          metadata: {
            outcome: "success",
            path: null,
            skillSource: "built-in",
            slug: name,
            surface: "chat",
          },
        }),
      ]);
    },
  );

  test.each(BUILT_IN_NAMES)(
    "%s resolves as the active skill by name, read-only",
    async (name) => {
      const active = unwrap(
        await resolveActiveSkillContext({
          ...callerWithoutRows(),
          activeSkill: { skillName: name },
          memberRole: { role: "owner" },
        }),
      );

      expect(active).toMatchObject({
        editable: false,
        id: null,
        source: "built-in",
        toolName: name,
      });
    },
  );

  test.each(BUILT_IN_NAMES)(
    "%s reports a resource it does not ship as not found",
    async (name) => {
      const read = unwrap(
        await readAvailableChatSkillResource({
          ...callerWithoutRows(),
          path: "knowledge/not-shipped.md",
          skillName: name,
        }),
      );

      expect(read).toEqual({
        status: "resource-not-found",
        skill: { source: "built-in" },
      });
    },
  );

  test("an unknown name without a row id is not an active skill", async () => {
    const active = await resolveActiveSkillContext({
      ...callerWithoutRows(),
      activeSkill: { skillName: "no-such-built-in" },
      memberRole: { role: "owner" },
    });

    if (Result.isOk(active)) {
      throw new Error("expected an unknown built-in name to be refused");
    }
    expect(active.error).toBeInstanceOf(HandlerError);
    expect(active.error).toMatchObject({ status: 404 });
  });
});

describe("an installed row and a built-in with the same slug", () => {
  const name = BUILT_IN_NAMES.at(0) ?? "";

  const insertShadow = async (enabled: boolean) => {
    const id = testId<"agentSkill">();
    await testDb.insert(agentSkills).values({
      id,
      organizationId: ids.orgA,
      userId: ids.userA1,
      scope: "private",
      origin: "authored",
      slug: name,
      name: `Shadow of ${name}`,
      description: "Installed shadow",
      version: null,
      metadata: {},
      contentHash: "0".repeat(64),
      body: "Installed shadow body",
      enabled,
    });
    return id;
  };

  const callerA = () => ({
    organizationId: ids.orgA,
    safeDb,
    userId: ids.userA1,
  });

  test("an enabled row shadows the built-in in the catalog and on load", async () => {
    const id = await insertShadow(true);

    const catalog = unwrap(await listAvailableChatSkillMetadata(callerA()));
    const loaded = unwrap(
      await loadAvailableChatSkills({ ...callerA(), skillNames: [name] }),
    );

    expect(catalog.filter((skill) => skill.name === name)).toEqual([
      expect.objectContaining({ id, source: "installed" }),
    ]);
    expect(loaded.get(name)).toMatchObject({
      body: "Installed shadow body",
      id,
      source: "installed",
    });
    await testDb.delete(agentSkills).where(eq(agentSkills.id, id));
  });

  test("an enabled row shadows the built-in as the active skill picked by name", async () => {
    const id = await insertShadow(true);

    const active = unwrap(
      await resolveActiveSkillContext({
        ...callerA(),
        activeSkill: { skillName: name },
        memberRole: { role: "owner" },
      }),
    );

    expect(active).toMatchObject({
      body: "Installed shadow body",
      displayName: `Shadow of ${name}`,
      id,
      source: "installed",
      toolName: name,
    });
    await testDb.delete(agentSkills).where(eq(agentSkills.id, id));
  });

  test("a disabled row leaves the built-in served", async () => {
    const id = await insertShadow(false);

    const loaded = unwrap(
      await loadAvailableChatSkills({ ...callerA(), skillNames: [name] }),
    );
    const active = unwrap(
      await resolveActiveSkillContext({
        ...callerA(),
        activeSkill: { skillName: name },
        memberRole: { role: "owner" },
      }),
    );

    expect(loaded.get(name)).toMatchObject({ source: "built-in" });
    expect(active).toMatchObject({
      body: loadSkill(name).body,
      source: "built-in",
    });
    await testDb.delete(agentSkills).where(eq(agentSkills.id, id));
  });
});
