import type { agentSkills } from "@/api/db/schema";
import {
  canManageSkill,
  canReadActiveSkillBody,
} from "@/api/lib/agent-skills/access";
import type { SafeId } from "@/api/lib/branded-types";
import { hasManagementPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type CatalogueSkillHandleRow = Pick<
  typeof agentSkills.$inferSelect,
  | "boundClientId"
  | "boundWorkspaceId"
  | "enabled"
  | "id"
  | "invocation"
  | "origin"
  | "scope"
  | "slug"
  | "userId"
>;

// The selected columns either supply handles or decide their eligibility and
// precedence. Classify against the full table so a schema addition forces a decision.
const UNPROJECTED_SKILL_HANDLE_COLUMNS = [
  // Tenant scope is already enforced by the catalogue query.
  "organizationId",
  // Display name comes from the curated catalogue entry.
  "name",
  // Display description comes from the curated catalogue entry.
  "description",
  // Release version is not needed to resolve installed handles.
  "version",
  // Licensing belongs to the catalogue entry, not the installed handle.
  "license",
  // Compatibility belongs to the catalogue entry, not the installed handle.
  "compatibility",
  // Tool configuration remains server-side and is not exposed through handles.
  "metadata",
  // Installation provenance does not affect handle eligibility.
  "sourceUrl",
  // Body integrity is checked when the skill is read or edited.
  "contentHash",
  // Skill content is not part of catalogue handles.
  "body",
  // Slash-command discovery owns command handles separately.
  "command",
  // Installation time does not affect handle eligibility.
  "createdAt",
  // Edit bookkeeping does not affect handle eligibility.
  "updatedAt",
] as const satisfies readonly (keyof typeof agentSkills.$inferSelect)[];

type MissingSkillHandleColumn = UnprojectedColumns<
  typeof agentSkills.$inferSelect,
  CatalogueSkillHandleRow,
  (typeof UNPROJECTED_SKILL_HANDLE_COLUMNS)[number]
>;
type UnexpectedSkillHandleColumn = UnbackedProjectionKeys<
  typeof agentSkills.$inferSelect,
  CatalogueSkillHandleRow,
  (typeof UNPROJECTED_SKILL_HANDLE_COLUMNS)[number]
>;

true satisfies MissingSkillHandleColumn extends never ? true : never;
true satisfies UnexpectedSkillHandleColumn extends never ? true : never;

type ResolveCatalogueSkillHandleMapsArgs = {
  memberRole: AuthorizedMemberRole;
  rows: readonly CatalogueSkillHandleRow[];
  userId: SafeId<"user">;
};

export const resolveCatalogueSkillHandleMaps = ({
  memberRole,
  rows,
  userId,
}: ResolveCatalogueSkillHandleMapsArgs) => {
  const preferTeam = hasManagementPermission(memberRole, {
    agentSkill: ["delete"],
  });
  const visibleRowBySlug = selectCatalogueSkillRows({
    isCandidate: () => true,
    preferTeam,
    rows,
  });
  const installedSkillRowBySlug = selectCatalogueSkillRows({
    isCandidate: (skill) =>
      canManageSkill({ memberRole, skill, spends: "delete", userId }),
    preferTeam,
    rows,
  });
  const chatSkillRowBySlug = selectCatalogueSkillRows({
    isCandidate: (row) =>
      canReadActiveSkillBody({
        ...row,
        memberRole,
        skillUserId: row.userId,
        userId,
      }),
    preferTeam,
    rows,
  });

  return {
    chatSkillIdBySlug: mapSkillIdsBySlug(chatSkillRowBySlug),
    enabledBySlug: mapSkillEnabledBySlug(visibleRowBySlug),
    invocationBySlug: new Map(
      [...visibleRowBySlug].map(([slug, row]) => [slug, row.invocation]),
    ),
    installedSkillIdBySlug: mapSkillIdsBySlug(installedSkillRowBySlug),
  };
};

type SelectCatalogueSkillRowsArgs = {
  isCandidate: (row: CatalogueSkillHandleRow) => boolean;
  preferTeam: boolean;
  rows: readonly CatalogueSkillHandleRow[];
};

const selectCatalogueSkillRows = ({
  isCandidate,
  preferTeam,
  rows,
}: SelectCatalogueSkillRowsArgs) => {
  const selected = new Map<string, CatalogueSkillHandleRow>();
  for (const row of rows) {
    if (!isCandidate(row)) {
      continue;
    }

    const existing = selected.get(row.slug);
    if (
      !existing ||
      shouldPreferCatalogueSkillRow({ existing, preferTeam, row })
    ) {
      selected.set(row.slug, row);
    }
  }
  return selected;
};

const shouldPreferCatalogueSkillRow = ({
  existing,
  preferTeam,
  row,
}: {
  existing: CatalogueSkillHandleRow;
  preferTeam: boolean;
  row: CatalogueSkillHandleRow;
}) => {
  if (existing.scope === row.scope) {
    return false;
  }

  return preferTeam ? row.scope === "team" : row.scope === "private";
};

const mapSkillIdsBySlug = (
  rowsBySlug: ReadonlyMap<string, CatalogueSkillHandleRow>,
) => {
  const idsBySlug = new Map<string, SafeId<"agentSkill">>();
  for (const [slug, row] of rowsBySlug) {
    idsBySlug.set(slug, row.id);
  }
  return idsBySlug;
};

const mapSkillEnabledBySlug = (
  rowsBySlug: ReadonlyMap<string, CatalogueSkillHandleRow>,
) => {
  const enabledBySlug = new Map<string, boolean>();
  for (const [slug, row] of rowsBySlug) {
    enabledBySlug.set(slug, row.enabled);
  }
  return enabledBySlug;
};
