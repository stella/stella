import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import type { MemberRole } from "@/api/lib/member-roles";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestExecutable, asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import {
  createSkillPackageTools,
  SAVE_SKILL_PACKAGE_TOOL_NAME,
  VALIDATE_SKILL_PACKAGE_TOOL_NAME,
} from "./skill-package-tools";

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
        inArray(agentSkills.userId, [ids.userA1, ids.userA2, ids.userAdmin]),
      ),
    );
  await releaseRlsFixture();
});

type ToolOutput = Record<string, unknown>;

const runTool = async ({
  input,
  role = "member",
  toolName,
  userId = ids.userA1,
}: {
  input: Record<string, unknown>;
  role?: MemberRole;
  toolName:
    | typeof SAVE_SKILL_PACKAGE_TOOL_NAME
    | typeof VALIDATE_SKILL_PACKAGE_TOOL_NAME;
  userId?: SafeId<"user">;
}): Promise<ToolOutput> => {
  const recordAuditEvent: AuditRecorder = async () => undefined;
  const tools = createSkillPackageTools({
    memberRole: sessionMemberRole(role),
    organizationId: ids.orgA,
    recordAuditEvent,
    safeDb: asTestRaw<SafeDb>(createSafeDb(testDb, [], ids.orgA, userId)),
    userId,
  });
  const tool = asTestExecutable<Record<string, unknown>, ToolOutput>(
    tools[toolName],
  );
  if (tool?.execute === undefined) {
    return panic(`Expected an executable ${toolName}`);
  }
  return await tool.execute(input);
};

const skillMd = (name: string) => `---
name: ${name}
description: Checks a contract against Czech law.
---
# ${name}

Read \`references/formation.md\`, then \`references/remedies.md\`.`;

const skillIdOf = (output: ToolOutput): SafeId<"agentSkill"> => {
  const { skillId } = output;
  return typeof skillId === "string"
    ? toSafeId<"agentSkill">(skillId)
    : panic(`Expected a skillId in ${JSON.stringify(output)}`);
};

/** What a call that must fail threw; bun-types declares `.rejects` void. */
const refusal = async (call: Promise<unknown>): Promise<unknown> =>
  await call.then(
    () => panic("Expected the call to be refused"),
    (error: unknown) => error,
  );

const storedResources = async (skillId: SafeId<"agentSkill">) =>
  await testDb
    .select({
      content: agentSkillResources.content,
      path: agentSkillResources.path,
    })
    .from(agentSkillResources)
    .where(eq(agentSkillResources.skillId, skillId))
    .orderBy(agentSkillResources.path);

describe("save_skill_package", () => {
  test("saves a package over several calls, then reports it complete", async () => {
    const first = await runTool({
      toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
      input: {
        skillMd: skillMd("chunked-contracts"),
        resources: [{ path: "references/formation.md", content: "Offer." }],
      },
    });
    expect(first).toMatchObject({
      status: "saved",
      scope: "private",
      complete: false,
      created: ["references/formation.md"],
      missingReferences: ["references/remedies.md"],
    });
    const skillId = skillIdOf(first);
    expect(first["url"]).toEndWith(`/knowledge/tools/${skillId}`);
    const [row] = await testDb
      .select({ enabled: agentSkills.enabled })
      .from(agentSkills)
      .where(eq(agentSkills.id, skillId));
    expect(row?.enabled).toBe(false);

    const second = await runTool({
      toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
      input: {
        skillId,
        resources: [{ path: "references/remedies.md", content: "Damages." }],
      },
    });
    expect(second).toMatchObject({
      status: "saved",
      complete: true,
      created: ["references/remedies.md"],
      updated: [],
      missingReferences: [],
    });

    const third = await runTool({
      toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
      input: {
        skillId,
        resources: [
          { path: "references/formation.md", content: "Offer, acceptance." },
          { path: "references/extra.md", content: "Extra." },
        ],
      },
    });
    expect(third).toMatchObject({
      created: ["references/extra.md"],
      updated: ["references/formation.md"],
    });
    const fourth = await runTool({
      toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
      input: { skillId, deletePaths: ["references/extra.md", "absent.md"] },
    });
    expect(fourth).toMatchObject({ deleted: ["references/extra.md"] });
    expect(await storedResources(skillId)).toEqual([
      { content: "Offer, acceptance.", path: "references/formation.md" },
      { content: "Damages.", path: "references/remedies.md" },
    ]);

    const validated = await runTool({
      toolName: VALIDATE_SKILL_PACKAGE_TOOL_NAME,
      input: { skillId },
    });
    expect(validated).toMatchObject({
      status: "accepted",
      skillId,
      missingReferences: [],
    });
  });

  test("writes nothing when the changed package is refused", async () => {
    const created = await runTool({
      toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
      input: {
        skillMd: skillMd("refused-contracts"),
        resources: [{ path: "references/formation.md", content: "Offer." }],
      },
    });
    const skillId = skillIdOf(created);
    const before = await storedResources(skillId);

    const refused = await runTool({
      toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
      input: {
        skillId,
        skillMd: "---\nname: Not A Name\ndescription: x\n---\nBody",
        resources: [{ path: "references/Formation.md", content: "Clash." }],
      },
    });
    expect(refused["status"]).toBe("rejected");
    expect(
      (Array.isArray(refused["diagnostics"]) ? refused["diagnostics"] : [])
        .map((diagnostic: unknown) =>
          typeof diagnostic === "object" &&
          diagnostic !== null &&
          "type" in diagnostic
            ? diagnostic.type
            : null,
        )
        .toSorted(),
    ).toEqual(["name_invalid", "resource_duplicate"]);
    expect(await storedResources(skillId)).toEqual(before);
    const [row] = await testDb
      .select({ name: agentSkills.name })
      .from(agentSkills)
      .where(eq(agentSkills.id, skillId));
    expect(row?.name).toBe("refused-contracts");
  });

  test("continues a skill of the same name instead of creating a second", async () => {
    const created = await runTool({
      toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
      input: { skillMd: skillMd("repeated-contracts") },
    });
    const repeated = await runTool({
      toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
      input: { skillMd: skillMd("repeated-contracts") },
    });
    expect(repeated).toMatchObject({
      status: "name_taken",
      skillId: skillIdOf(created),
    });
  });

  test("creates a team skill only for an admin or owner", async () => {
    expect(
      await refusal(
        runTool({
          toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
          input: { scope: "team", skillMd: skillMd("team-contracts-member") },
        }),
      ),
    ).toBeInstanceOf(ChatToolError);

    const owner = await runTool({
      role: "owner",
      toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
      userId: ids.userAdmin,
      input: { scope: "team", skillMd: skillMd("team-contracts-owner") },
    });
    expect(owner).toMatchObject({ status: "saved", scope: "team" });
  });

  test("refuses another member's private skill", async () => {
    const created = await runTool({
      toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
      input: { skillMd: skillMd("owned-contracts") },
    });
    const skillId = skillIdOf(created);

    expect(
      await refusal(
        runTool({
          toolName: SAVE_SKILL_PACKAGE_TOOL_NAME,
          userId: ids.userA2,
          input: {
            skillId,
            resources: [{ path: "references/formation.md", content: "x" }],
          },
        }),
      ),
    ).toBeInstanceOf(ChatToolError);
    expect(await storedResources(skillId)).toEqual([]);
  });
});
