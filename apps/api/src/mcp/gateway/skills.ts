import { Result } from "better-result";
import { and, asc, eq, or } from "drizzle-orm";

import { agentSkills } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { LIMITS } from "@/api/lib/limits";
import {
  collisionSafeToolName,
  namespaceSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpRequestContext } from "@/api/mcp/context";

type SkillToolRow = {
  body: string;
  description: string;
  id: typeof agentSkills.$inferSelect.id;
  metadata: Record<string, string>;
  name: string;
  origin: typeof agentSkills.$inferSelect.origin;
  scope: typeof agentSkills.$inferSelect.scope;
  slug: string;
  userId: string;
  version: string | null;
  compatibility: string | null;
  license: string | null;
};

export type ResolvedSkillTool = SkillToolRow & {
  exposedName: string;
};

export const loadVisibleSkillTools = async ({
  context,
}: {
  context: McpRequestContext;
}): Promise<ResolvedSkillTool[]> => {
  const rows = await context.safeDb((tx) =>
    tx
      .select({
        id: agentSkills.id,
        scope: agentSkills.scope,
        userId: agentSkills.userId,
        slug: agentSkills.slug,
        name: agentSkills.name,
        description: agentSkills.description,
        version: agentSkills.version,
        license: agentSkills.license,
        compatibility: agentSkills.compatibility,
        metadata: agentSkills.metadata,
        body: agentSkills.body,
        origin: agentSkills.origin,
      })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.organizationId, context.organizationId),
          eq(agentSkills.enabled, true),
          or(
            eq(agentSkills.scope, "team"),
            eq(agentSkills.userId, context.userId),
          ),
        ),
      )
      .orderBy(agentSkills.scope, asc(agentSkills.slug), asc(agentSkills.id))
      .limit(LIMITS.mcpGatewaySkillsMax * 2),
  );

  if (Result.isError(rows)) {
    captureError(rows.error, { source: "mcp-gateway-skills" });
    return [];
  }

  return resolveSkillToolPrecedence(rows.value);
};

export const resolveSkillTool = async ({
  context,
  toolName,
}: {
  context: McpRequestContext;
  toolName: string;
}): Promise<ResolvedSkillTool | null> =>
  (await loadVisibleSkillTools({ context })).find(
    (skill) => skill.exposedName === toolName,
  ) ?? null;

const resolveSkillToolPrecedence = (
  rows: readonly SkillToolRow[],
): ResolvedSkillTool[] => {
  const skills: ResolvedSkillTool[] = [];
  const seenSlugs = new Set<string>();
  const seenToolNames = new Set<string>();

  for (const row of rows.toSorted(
    (a, b) => scopePriority(a.scope) - scopePriority(b.scope),
  )) {
    if (
      skills.length >= LIMITS.mcpGatewaySkillsMax ||
      seenSlugs.has(row.slug)
    ) {
      continue;
    }

    seenSlugs.add(row.slug);
    const baseName = namespaceSkillToolName(row.slug);
    skills.push({
      ...row,
      exposedName: collisionSafeToolName({
        baseName,
        rawName: row.slug,
        seen: seenToolNames,
      }),
    });
  }

  return skills.toSorted((a, b) => a.exposedName.localeCompare(b.exposedName));
};

const scopePriority = (scope: "team" | "private") =>
  scope === "private" ? 0 : 1;
