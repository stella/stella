import { and, eq, inArray } from "drizzle-orm";

import { SKILL_REF_HREF_PREFIX } from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { agentSkills } from "@/api/db/schema";
import { extractSkillRefSlugs } from "@/api/lib/agent-skills/skill-refs";
import { ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS } from "@/api/lib/agent-skills/skills";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Linked skills one extraction batch carries. Each body rides in the batch
 * request next to the documents, so the bound keeps prompts that link many
 * skills from crowding out the sources.
 */
const TEAM_SKILL_REFS_PRELOAD_MAX = 3;

type LoadedTeamSkill = {
  body: string;
  name: string;
  slug: string;
};

export type TeamSkillRefs = {
  /** Linked, enabled team skills whose instructions the batch carries. */
  loaded: LoadedTeamSkill[];
  /** Linked enabled team skills past the preload bound. */
  notPreloaded: string[];
  /** Linked skills that are not enabled team skills of the organization. */
  unavailable: string[];
};

type ResolveTeamSkillRefsOptions = {
  organizationId: SafeId<"organization">;
  prompts: readonly string[];
};

/**
 * Resolves the skill links (`[label](#stella-skill-ref=slug)`) in property
 * prompts against the organization's enabled team skills. Extraction writes
 * shared matter data, so a member's private skill never shapes it, whoever
 * authored the prompt.
 */
export const resolveTeamSkillRefs = async (
  scopedDb: ScopedDb,
  { organizationId, prompts }: ResolveTeamSkillRefsOptions,
): Promise<TeamSkillRefs> => {
  const referenced = [...new Set(prompts.flatMap(extractSkillRefSlugs))];
  if (referenced.length === 0) {
    return { loaded: [], notPreloaded: [], unavailable: [] };
  }

  const rows = await scopedDb(
    async (tx) =>
      await tx
        .select({
          body: agentSkills.body,
          name: agentSkills.name,
          slug: agentSkills.slug,
        })
        .from(agentSkills)
        .where(
          and(
            eq(agentSkills.organizationId, organizationId),
            eq(agentSkills.scope, "team"),
            eq(agentSkills.enabled, true),
            inArray(agentSkills.slug, referenced),
          ),
        ),
  );
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const available = referenced.flatMap((slug) => {
    const row = bySlug.get(slug);
    return row === undefined ? [] : [row];
  });

  return {
    loaded: available.slice(0, TEAM_SKILL_REFS_PRELOAD_MAX),
    notPreloaded: available
      .slice(TEAM_SKILL_REFS_PRELOAD_MAX)
      .map(({ slug }) => slug),
    unavailable: referenced.filter((slug) => !bySlug.has(slug)),
  };
};

/**
 * The batch message that carries the linked skills' instructions and names
 * the links the model has to answer without, or null when no prompt links a
 * skill.
 */
export const teamSkillRefsMessage = ({
  loaded,
  notPreloaded,
  unavailable,
}: TeamSkillRefs): string | null => {
  if (
    loaded.length === 0 &&
    notPreloaded.length === 0 &&
    unavailable.length === 0
  ) {
    return null;
  }
  const sections = [
    `LINKED SKILLS: A prompt that contains a link of the form [label](${SKILL_REF_HREF_PREFIX}slug) asks you to answer it with that skill's method.`,
    // The same per-skill cap chat applies. Extraction has no load-skill tool,
    // so a longer body is cut and says so.
    ...loaded.map(({ body, name, slug }) =>
      body.length > ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS
        ? `SKILL ${slug} (${name}) instructions (first ${String(ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS)} characters; the rest is cut):\n${body.slice(0, ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS)}`
        : `SKILL ${slug} (${name}) instructions:\n${body}`,
    ),
  ];
  const missing = [...notPreloaded, ...unavailable];
  if (missing.length > 0) {
    sections.push(
      `These linked skills are not available here: ${missing.join(", ")}. Answer the prompts that link them from the sources alone.`,
    );
  }
  return sections.join("\n\n");
};
