import type {
  agentSkillResources,
  agentSkillRevisions,
  agentSkills,
} from "@/api/db/schema";

type AgentSkillResponseRow = Pick<
  typeof agentSkills.$inferSelect,
  | "id"
  | "scope"
  | "origin"
  | "userId"
  | "slug"
  | "name"
  | "description"
  | "version"
  | "license"
  | "compatibility"
  | "sourceUrl"
  | "contentHash"
  | "enabled"
  | "body"
  | "command"
  | "createdAt"
>;

type AgentSkillResourceResponseRow = Pick<
  typeof agentSkillResources.$inferSelect,
  "id" | "path" | "kind" | "sizeBytes" | "content"
>;

export const toAgentSkillResponse = (
  skill: AgentSkillResponseRow,
  resources: readonly AgentSkillResourceResponseRow[],
) => ({
  id: skill.id,
  scope: skill.scope,
  origin: skill.origin,
  userId: skill.userId,
  slug: skill.slug,
  name: skill.name,
  description: skill.description,
  version: skill.version,
  license: skill.license,
  compatibility: skill.compatibility,
  sourceUrl: skill.sourceUrl,
  contentHash: skill.contentHash,
  enabled: skill.enabled,
  body: skill.body,
  command: skill.command,
  createdAt: skill.createdAt,
  resources: resources.map(({ id, path, kind, sizeBytes, content }) => ({
    id,
    path,
    kind,
    sizeBytes,
    content,
  })),
});

type AgentSkillRevisionResponseRow = Pick<
  typeof agentSkillRevisions.$inferSelect,
  | "id"
  | "skillId"
  | "revisionNumber"
  | "body"
  | "contentHash"
  | "createdBy"
  | "createdAt"
  | "updatedAt"
>;

export const toAgentSkillRevisionResponse = (
  revision: AgentSkillRevisionResponseRow,
) => ({
  id: revision.id,
  skillId: revision.skillId,
  revisionNumber: revision.revisionNumber,
  body: revision.body,
  contentHash: revision.contentHash,
  createdBy: revision.createdBy,
  createdAt: revision.createdAt,
  updatedAt: revision.updatedAt,
});
