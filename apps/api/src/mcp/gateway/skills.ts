import { panic, Result } from "better-result";
import { and, asc, eq, or } from "drizzle-orm";

import { listSkillMetadata, loadSkill } from "@stll/skills";

import { agentSkills } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { LIMITS } from "@/api/lib/limits";
import {
  collisionSafeToolName,
  namespaceSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpRequestContext } from "@/api/mcp/context";
import { McpGatewayLoadError } from "@/api/mcp/errors";

type SkillToolContent = {
  body: string;
  compatibility: string | null;
  description: string;
  license: string | null;
  metadata: Record<string, string>;
  name: string;
  slug: string;
  version: string | null;
};

/** An enabled `agent_skills` row the caller can see. */
export type SkillToolRow = SkillToolContent & {
  id: typeof agentSkills.$inferSelect.id;
  origin: typeof agentSkills.$inferSelect.origin;
  scope: typeof agentSkills.$inferSelect.scope;
  userId: string;
};

export const SKILL_TOOL_SOURCE = {
  builtIn: "built-in",
  installed: "installed",
} as const;

/**
 * A skill the gateway serves: an installed row, or a skill shipped with stella
 * (`@stll/skills`), which every organization has with no row, so it carries no
 * id, scope, or owner.
 */
export type SkillToolSource =
  | (SkillToolRow & { source: typeof SKILL_TOOL_SOURCE.installed })
  | (SkillToolContent & { source: typeof SKILL_TOOL_SOURCE.builtIn });

export type ResolvedSkillTool = SkillToolSource & {
  exposedName: string;
};

/** The `origin` a served skill reports: its row's, or built-in. */
export const skillToolOrigin = (
  skill: SkillToolSource,
): SkillToolRow["origin"] | typeof SKILL_TOOL_SOURCE.builtIn => {
  switch (skill.source) {
    case SKILL_TOOL_SOURCE.installed:
      return skill.origin;
    case SKILL_TOOL_SOURCE.builtIn:
      return SKILL_TOOL_SOURCE.builtIn;
    default: {
      skill satisfies never;
      return panic(`Unhandled skill source: ${String(skill)}`);
    }
  }
};

/** Built-ins as the gateway serves them, read once from the deployed bytes. */
let builtInSkillTools: SkillToolContent[] | undefined;

export const listBuiltInSkillTools = (): readonly SkillToolContent[] => {
  builtInSkillTools ??= listSkillMetadata().map(({ name }) => {
    const skill = loadSkill(name);
    return {
      body: skill.body,
      compatibility: skill.compatibility ?? null,
      description: skill.description,
      license: skill.license ?? null,
      metadata: skill.metadata ?? {},
      name: skill.name,
      slug: skill.name,
      version: skill.version,
    };
  });
  return builtInSkillTools;
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
    // Propagate the load fault instead of `[]`, so a transient DB outage is not
    // mistaken for "no skills": dispatch maps this to a retryable error and
    // `tools/list` fails loudly rather than silently dropping skill tools.
    throw new McpGatewayLoadError({
      message: "Failed to load agent skills",
      cause: rows.error,
    });
  }

  return resolveSkillToolPrecedence({
    builtIn: listBuiltInSkillTools(),
    installed: rows.value,
  });
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

/**
 * Pure naming and precedence step, exported so tests and the orientation eval
 * derive collision-safe exposed names through the served code path rather
 * than a hand-written mirror of it. An installed skill shadows a built-in with
 * the same slug, as a private row shadows a team row; chat resolves the same
 * way (`resolveSkillPrecedence` in `lib/agent-skills/skills.ts`).
 */
export const resolveSkillToolPrecedence = ({
  builtIn,
  installed,
}: {
  builtIn: readonly SkillToolContent[];
  installed: readonly SkillToolRow[];
}): ResolvedSkillTool[] => {
  const skills: ResolvedSkillTool[] = [];
  const seenSlugs = new Set<string>();
  const seenToolNames = new Set<string>();
  const candidates: SkillToolSource[] = [];
  for (const row of installed.toSorted(
    (a, b) => scopePriority(a.scope) - scopePriority(b.scope),
  )) {
    candidates.push({ ...row, source: SKILL_TOOL_SOURCE.installed });
  }
  for (const skill of builtIn) {
    candidates.push({ ...skill, source: SKILL_TOOL_SOURCE.builtIn });
  }

  for (const candidate of candidates) {
    if (
      skills.length >= LIMITS.mcpGatewaySkillsMax ||
      seenSlugs.has(candidate.slug)
    ) {
      continue;
    }

    seenSlugs.add(candidate.slug);
    skills.push({
      ...candidate,
      exposedName: collisionSafeToolName({
        baseName: namespaceSkillToolName(candidate.slug),
        rawName: candidate.slug,
        seen: seenToolNames,
      }),
    });
  }

  // oxlint-disable-next-line require-cached-collator/require-cached-collator -- exposedName is the MCP tool registry's machine identifier, not display text
  return skills.toSorted((a, b) => a.exposedName.localeCompare(b.exposedName));
};

const scopePriority = (scope: "team" | "private") =>
  scope === "private" ? 0 : 1;
