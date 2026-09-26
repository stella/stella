import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { agentSkills } from "@/api/db/schema";
import { ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS } from "@/api/lib/agent-skills/skills";
import type { SafeId } from "@/api/lib/branded-types";
import { insertTestSkill } from "@/api/tests/helpers/agent-skill-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { resolveTeamSkillRefs, teamSkillRefsMessage } from "./team-skill-refs";

// Property extraction fills shared matter data, so a skill a property prompt
// links is read from the organization's enabled team skills only.

let testDb: TestDatabase;
let ids: TestIds;
const skillIds: SafeId<"agentSkill">[] = [];
const suffix = Bun.randomUUIDv7().slice(-8);
const TEAM = `team-review-${suffix}`;
const DISABLED = `disabled-review-${suffix}`;
const PRIVATE = `private-review-${suffix}`;
const OTHER_ORG = `other-org-review-${suffix}`;
const MISSING = `missing-review-${suffix}`;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const seed = async (
    slug: string,
    scope: "private" | "team",
    organizationId = ids.orgA,
  ) => {
    const id = await insertTestSkill(testDb, {
      body: `Instructions of ${slug}.`,
      organizationId,
      scope,
      slug,
      userId: organizationId === ids.orgA ? ids.userAdmin : ids.userB1,
    });
    skillIds.push(id);
    return id;
  };
  await seed(TEAM, "team");
  const disabled = await seed(DISABLED, "team");
  await testDb
    .update(agentSkills)
    .set({ enabled: false })
    .where(eq(agentSkills.id, disabled));
  await seed(PRIVATE, "private");
  await seed(OTHER_ORG, "team", ids.orgB);
});

afterAll(async () => {
  await testDb.delete(agentSkills).where(inArray(agentSkills.id, skillIds));
  await releaseRlsFixture();
});

const scopedDb: ScopedDb = async (fn) =>
  await fn(asTestRaw<Transaction>(testDb));

const ref = (slug: string) => `[${slug}](#stella-skill-ref=${slug})`;

describe("skill refs in property prompts", () => {
  test("load only the organization's enabled team skills", async () => {
    const refs = await resolveTeamSkillRefs(scopedDb, {
      organizationId: ids.orgA,
      prompts: [
        `Summarise the term using ${ref(TEAM)} and ${ref(PRIVATE)}.`,
        `Check ${ref(DISABLED)}, ${ref(OTHER_ORG)} and ${ref(MISSING)}.`,
        `Again ${ref(TEAM)}.`,
      ],
    });

    expect(refs.loaded.map(({ slug, body }) => ({ slug, body }))).toEqual([
      { slug: TEAM, body: `Instructions of ${TEAM}.` },
    ]);
    expect(refs.unavailable).toEqual([PRIVATE, DISABLED, OTHER_ORG, MISSING]);
  });

  test("tell the model which linked skills it has and which it lacks", async () => {
    const refs = await resolveTeamSkillRefs(scopedDb, {
      organizationId: ids.orgA,
      prompts: [`Use ${ref(TEAM)} and ${ref(PRIVATE)}.`],
    });

    const message = teamSkillRefsMessage(refs);

    expect(message).toContain(`Instructions of ${TEAM}.`);
    expect(message).toContain(PRIVATE);
    expect(message).not.toContain(`Instructions of ${PRIVATE}.`);
  });

  test("a linked skill body past the prompt cap is cut and says so", () => {
    const body = "x".repeat(ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS + 1);

    const message = teamSkillRefsMessage({
      loaded: [{ body, name: "Long", slug: "long" }],
      notPreloaded: [],
      unavailable: [],
    });

    expect(message).toContain("the rest is cut");
    expect(message).not.toContain(body);
    expect(message).toContain(
      body.slice(0, ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS),
    );
  });

  test("prompts without skill links add nothing", async () => {
    const refs = await resolveTeamSkillRefs(scopedDb, {
      organizationId: ids.orgA,
      prompts: ["Extract the effective date."],
    });

    expect(teamSkillRefsMessage(refs)).toBeNull();
  });
});
