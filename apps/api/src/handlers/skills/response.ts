import type {
  agentSkillResources,
  agentSkillRevisions,
  agentSkills,
} from "@/api/db/schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

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
  | "invocation"
  | "body"
  | "command"
  | "boundClientId"
  | "boundWorkspaceId"
  | "createdAt"
>;

type AgentSkillResourceResponseRow = Pick<
  typeof agentSkillResources.$inferSelect,
  "id" | "path" | "sizeBytes" | "content"
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
  invocation: skill.invocation,
  body: skill.body,
  command: skill.command,
  boundClientId: skill.boundClientId,
  boundWorkspaceId: skill.boundWorkspaceId,
  createdAt: skill.createdAt,
  resources: resources.map(({ id, path, sizeBytes, content }) => ({
    id,
    path,
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

// The guards run against the full table rows, not the narrowed inputs above,
// so a new column must be classified here before it can drift silently.
type AgentSkillResponse = ReturnType<typeof toAgentSkillResponse>;
// `resources` is the skill's child rows, guarded separately below.
type AgentSkillProjectionRow = typeof agentSkills.$inferSelect &
  Pick<AgentSkillResponse, "resources">;

// Columns intentionally not sent to the client (skills.get and the account
// export share this response).
const UNPROJECTED_AGENT_SKILL_COLUMNS = [
  // Tenant id: the caller already knows its active organization.
  "organizationId",
  // Parsed frontmatter that wires tool access (documented reads, excluded
  // and required tools); runtime configuration read server-side only.
  "metadata",
  // Write bookkeeping; revisions carry the edit history with timestamps.
  "updatedAt",
] as const satisfies readonly (keyof AgentSkillProjectionRow)[];

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column.
type MissingProjectedAgentSkillColumn = UnprojectedColumns<
  AgentSkillProjectionRow,
  AgentSkillResponse,
  (typeof UNPROJECTED_AGENT_SKILL_COLUMNS)[number]
>;
type UnexpectedProjectedAgentSkillColumn = UnbackedProjectionKeys<
  AgentSkillProjectionRow,
  AgentSkillResponse,
  (typeof UNPROJECTED_AGENT_SKILL_COLUMNS)[number]
>;

true satisfies MissingProjectedAgentSkillColumn extends never ? true : never;
true satisfies UnexpectedProjectedAgentSkillColumn extends never ? true : never;

type AgentSkillResourceRow = typeof agentSkillResources.$inferSelect;
type AgentSkillResourceResponse = AgentSkillResponse["resources"][number];

// Columns intentionally not sent to the client.
const UNPROJECTED_AGENT_SKILL_RESOURCE_COLUMNS = [
  // Tenant id: the caller already knows its active organization.
  "organizationId",
  // Resources are nested under the skill they belong to.
  "skillId",
  // Written together with the skill; the skill's own timestamps date it.
  "createdAt",
] as const satisfies readonly (keyof AgentSkillResourceRow)[];

type MissingProjectedAgentSkillResourceColumn = UnprojectedColumns<
  AgentSkillResourceRow,
  AgentSkillResourceResponse,
  (typeof UNPROJECTED_AGENT_SKILL_RESOURCE_COLUMNS)[number]
>;
type UnexpectedProjectedAgentSkillResourceColumn = UnbackedProjectionKeys<
  AgentSkillResourceRow,
  AgentSkillResourceResponse,
  (typeof UNPROJECTED_AGENT_SKILL_RESOURCE_COLUMNS)[number]
>;

true satisfies MissingProjectedAgentSkillResourceColumn extends never
  ? true
  : never;
true satisfies UnexpectedProjectedAgentSkillResourceColumn extends never
  ? true
  : never;

type AgentSkillRevisionRow = typeof agentSkillRevisions.$inferSelect;
type AgentSkillRevisionResponse = ReturnType<
  typeof toAgentSkillRevisionResponse
>;

// Columns intentionally not sent to the client.
const UNPROJECTED_AGENT_SKILL_REVISION_COLUMNS = [
  // Tenant id: the caller already knows its active organization.
  "organizationId",
] as const satisfies readonly (keyof AgentSkillRevisionRow)[];

type MissingProjectedAgentSkillRevisionColumn = UnprojectedColumns<
  AgentSkillRevisionRow,
  AgentSkillRevisionResponse,
  (typeof UNPROJECTED_AGENT_SKILL_REVISION_COLUMNS)[number]
>;
type UnexpectedProjectedAgentSkillRevisionColumn = UnbackedProjectionKeys<
  AgentSkillRevisionRow,
  AgentSkillRevisionResponse,
  (typeof UNPROJECTED_AGENT_SKILL_REVISION_COLUMNS)[number]
>;

true satisfies MissingProjectedAgentSkillRevisionColumn extends never
  ? true
  : never;
true satisfies UnexpectedProjectedAgentSkillRevisionColumn extends never
  ? true
  : never;
