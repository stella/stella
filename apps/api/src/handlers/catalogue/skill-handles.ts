import { Result } from "better-result";

import type { AgentSkillOrigin } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import { requireEditableSkillOrigin } from "../skills/origin";

type CatalogueSkillHandleRow = {
  enabled: boolean;
  id: SafeId<"agentSkill">;
  origin: AgentSkillOrigin;
  scope: "private" | "team";
  slug: string;
  userId: string;
};

type ResolveCatalogueSkillHandleMapsArgs = {
  canManageTeamSkills: boolean;
  rows: readonly CatalogueSkillHandleRow[];
  userId: SafeId<"user">;
};

export const resolveCatalogueSkillHandleMaps = ({
  canManageTeamSkills,
  rows,
  userId,
}: ResolveCatalogueSkillHandleMapsArgs) => {
  const visibleRowBySlug = selectCatalogueSkillRows({
    isCandidate: () => true,
    preferTeam: canManageTeamSkills,
    rows,
  });
  const installedSkillRowBySlug = selectCatalogueSkillRows({
    isCandidate: (row) => row.scope === "private" || canManageTeamSkills,
    preferTeam: canManageTeamSkills,
    rows,
  });
  const chatSkillRowBySlug = selectCatalogueSkillRows({
    isCandidate: (row) =>
      canUseCatalogueSkillAsChatContext({
        canManageTeamSkills,
        row,
        userId,
      }),
    preferTeam: canManageTeamSkills,
    rows,
  });

  return {
    chatSkillIdBySlug: mapSkillIdsBySlug(chatSkillRowBySlug),
    enabledBySlug: mapSkillEnabledBySlug(visibleRowBySlug),
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

const canUseCatalogueSkillAsChatContext = ({
  canManageTeamSkills,
  row,
  userId,
}: {
  canManageTeamSkills: boolean;
  row: CatalogueSkillHandleRow;
  userId: SafeId<"user">;
}) => {
  if (row.scope === "private") {
    return row.userId === userId;
  }

  if (row.enabled) {
    return true;
  }

  if (!canManageTeamSkills) {
    return false;
  }

  return !Result.isError(requireEditableSkillOrigin(row.origin));
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
