import { panic } from "better-result";
import { desc, eq } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import type { roles } from "@stll/permissions";

import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillRevisions, agentSkills } from "@/api/db/schema";
import type { AgentSkillOrigin, AgentSkillScope } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * PGlite-backed handler contexts and rows for agent skill handler tests. Every
 * context runs its queries through the same RLS-scoped `safeDb` production
 * handlers receive.
 */

type SkillHandlerContextOptions = {
  testDb: TestDatabase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  role?: keyof typeof roles;
  auditEvents?: AuditEvent[];
  body?: unknown;
  params?: unknown;
};

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the type parameter IS the API: callers pin the handler's own context type per call
export const skillHandlerContext = <TContext>({
  auditEvents = [],
  organizationId,
  role = "owner",
  testDb,
  userId,
  ...fields
}: SkillHandlerContextOptions): TContext => {
  const recordAuditEvent: AuditRecorder = async (_tx, events) => {
    if (Array.isArray(events)) {
      auditEvents.push(...events);
      return;
    }
    auditEvents.push(events);
  };
  return createTestHandlerContext<TContext>({
    ...fields,
    memberRole: { role },
    recordAuditEvent,
    createAuditRecorder: () => recordAuditEvent,
    safeDb: asTestRaw<SafeDb>(createSafeDb(testDb, [], organizationId, userId)),
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
  });
};

type HandlerFailure = { code: number; message: string };

/** The status and message of a handler result, or null when it succeeded. */
export const handlerFailure = (result: unknown): HandlerFailure | null => {
  if (!(result instanceof ElysiaCustomStatusResponse)) {
    return null;
  }
  const response: unknown = result.response;
  const message =
    typeof response === "object" &&
    response !== null &&
    "message" in response &&
    typeof response.message === "string"
      ? response.message
      : "";
  return { code: Number(result.code), message };
};

type InsertTestSkillOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scope?: AgentSkillScope;
  origin?: AgentSkillOrigin;
  slug?: string;
  name?: string;
  description?: string;
  body?: string;
  command?: string | null;
  contentHash?: string;
  sourceUrl?: string | null;
};

export const insertTestSkill = async (
  testDb: TestDatabase,
  {
    organizationId,
    userId,
    scope = "private",
    origin = "authored",
    slug = `skill-${Bun.randomUUIDv7()}`,
    name = slug,
    description = "Agent skill test fixture",
    body = "Follow the fixture instructions.",
    command = null,
    contentHash = "0".repeat(64),
    sourceUrl = null,
  }: InsertTestSkillOptions,
): Promise<SafeId<"agentSkill">> => {
  const id = toSafeId<"agentSkill">(Bun.randomUUIDv7());
  await testDb.insert(agentSkills).values({
    id,
    organizationId,
    userId,
    scope,
    origin,
    slug,
    name,
    description,
    metadata: {},
    contentHash,
    body,
    enabled: true,
    command,
    sourceUrl,
  });
  return id;
};

export const latestTestSkillRevisionId = async (
  testDb: TestDatabase,
  skillId: SafeId<"agentSkill">,
): Promise<SafeId<"agentSkillRevision">> => {
  const rows = await testDb
    .select({ id: agentSkillRevisions.id })
    .from(agentSkillRevisions)
    .where(eq(agentSkillRevisions.skillId, skillId))
    .orderBy(desc(agentSkillRevisions.revisionNumber))
    .limit(1);
  const row = rows.at(0);
  if (!row) {
    return panic("agent skill fixture has no revision");
  }
  return row.id;
};
