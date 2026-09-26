import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import type { Transaction } from "@/api/db/root";
import { agentSkills, auditLogs } from "@/api/db/schema";
import { hashSkillContent } from "@/api/lib/agent-skills/content-hash";
import { seedDefaultSkills } from "@/api/lib/agent-skills/default-skills";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { getAuth } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Default skills arrive with the membership: the real organization plugin
// flows create the member, and its hooks install the defaults.

setDefaultTimeout(120_000);

const DEFAULT_COMMANDS = ["compare", "draft", "risks", "summarize"];

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

type Membership = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const memberSkills = async ({ organizationId, userId }: Membership) =>
  await testDb
    .select({
      command: agentSkills.command,
      id: agentSkills.id,
      origin: agentSkills.origin,
      scope: agentSkills.scope,
    })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.organizationId, organizationId),
        eq(agentSkills.userId, userId),
      ),
    );

const skillCreationAudits = async ({ organizationId, userId }: Membership) =>
  await testDb
    .select({ resourceId: auditLogs.resourceId })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.userId, userId),
        eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.AGENT_SKILL),
      ),
    );

const createOrganization = async (owner: HumanBrowser) => {
  const organization = await getAuth().api.createOrganization({
    body: {
      name: "Default skills",
      slug: `default-skills-${Bun.randomUUIDv7()}`,
    },
    headers: owner.headers(),
  });
  return brandPersistedOrganizationId(organization.id);
};

const expectDefaults = async (membership: Membership) => {
  const skills = await memberSkills(membership);
  expect(skills).toHaveLength(DEFAULT_COMMANDS.length);
  expect(new Set(skills.map(({ command }) => command))).toEqual(
    new Set(DEFAULT_COMMANDS),
  );
  expect(new Set(skills.map(({ scope }) => scope))).toEqual(
    new Set(["private"]),
  );
  expect(new Set(skills.map(({ origin }) => origin))).toEqual(
    new Set(["authored"]),
  );
  const audits = await skillCreationAudits(membership);
  expect(audits.map(({ resourceId }) => resourceId).toSorted()).toEqual(
    skills.map(({ id }) => id).toSorted(),
  );
};

describe("default skills for a new membership", () => {
  test("creating an organization installs the creator's defaults", async () => {
    const owner = await signInHuman(
      `default-skills-owner-${Bun.randomUUIDv7()}@stella.dev`,
    );

    const organizationId = await createOrganization(owner);

    await expectDefaults({
      organizationId,
      userId: brandPersistedUserId(owner.userId),
    });
  });

  test("accepting an invitation installs the new member's defaults", async () => {
    const auth = getAuth();
    const owner = await signInHuman(
      `default-skills-inviter-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const organizationId = await createOrganization(owner);
    const invitee = await signInHuman(
      `default-skills-invitee-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const invitation = await auth.api.createInvitation({
      body: { email: invitee.email, role: "member", organizationId },
      headers: owner.headers(),
    });

    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: invitee.headers(),
    });

    await expectDefaults({
      organizationId,
      userId: brandPersistedUserId(invitee.userId),
    });
  });

  test("seeding the same membership again writes nothing", async () => {
    const owner = await signInHuman(
      `default-skills-repeat-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const membership = {
      organizationId: await createOrganization(owner),
      userId: brandPersistedUserId(owner.userId),
    };

    await testDb.transaction(async (tx) => {
      await seedDefaultSkills({
        ...membership,
        tx: asTestRaw<Transaction>(tx),
      });
    });

    await expectDefaults(membership);
  });
});

const BACKFILL_MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260925230400_agent_skill_default_backfill/migration.sql",
);

const applyBackfillMigration = async () => {
  const statements = readFileSync(BACKFILL_MIGRATION_PATH, "utf-8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await testDb.execute(sql.raw(statement));
  }
};

const ownerMembership = async (label: string): Promise<Membership> => {
  const owner = await signInHuman(
    `default-skills-${label}-${Bun.randomUUIDv7()}@stella.dev`,
  );
  return {
    organizationId: await createOrganization(owner),
    userId: brandPersistedUserId(owner.userId),
  };
};

const deleteMemberSkills = async (
  { organizationId, userId }: Membership,
  commands: readonly string[],
) => {
  for (const command of commands) {
    await testDb
      .delete(agentSkills)
      .where(
        and(
          eq(agentSkills.organizationId, organizationId),
          eq(agentSkills.userId, userId),
          eq(agentSkills.command, command),
        ),
      );
  }
};

describe("default skills for memberships that predate seeding at creation", () => {
  test("the backfill installs defaults only where the retired seed gate would", async () => {
    const unseeded = await ownerMembership("backfill-unseeded");
    await deleteMemberSkills(unseeded, DEFAULT_COMMANDS);
    const seeded = await ownerMembership("backfill-seeded");
    await deleteMemberSkills(seeded, ["summarize"]);

    await applyBackfillMigration();

    const backfilled = await testDb
      .select({
        body: agentSkills.body,
        command: agentSkills.command,
        contentHash: agentSkills.contentHash,
        description: agentSkills.description,
        name: agentSkills.name,
        origin: agentSkills.origin,
        scope: agentSkills.scope,
      })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.organizationId, unseeded.organizationId),
          eq(agentSkills.userId, unseeded.userId),
        ),
      );
    expect(backfilled.map(({ command }) => command).toSorted()).toEqual(
      DEFAULT_COMMANDS,
    );
    for (const {
      body,
      contentHash,
      description,
      name,
      origin,
      scope,
    } of backfilled) {
      expect({ origin, scope }).toEqual({
        origin: "authored",
        scope: "private",
      });
      expect(contentHash).toBe(
        hashSkillContent({
          body,
          compatibility: null,
          description,
          license: null,
          metadata: {},
          name,
          resources: [],
          version: null,
        }),
      );
    }

    const kept = await memberSkills(seeded);
    expect(kept.map(({ command }) => command).toSorted()).toEqual(
      DEFAULT_COMMANDS.filter((command) => command !== "summarize"),
    );
  });
});
