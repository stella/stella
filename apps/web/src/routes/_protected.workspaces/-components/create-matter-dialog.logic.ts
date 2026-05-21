type ExistingWorkspace = {
  client?: { id: string } | null;
  contributors: {
    lastActivity?: Date | string | null;
    userId?: string | null;
  }[];
  id: string;
  name: string;
  reference?: string | null;
};

type OrganizationMember = {
  user: { name: string };
  userId: string;
};

type CollaboratorStats = {
  activityCount: number;
  lastActivityMs: number;
  sharedCount: number;
  sharedLastActivityMs: number;
};

const MIN_DUPLICATE_TOKEN_LENGTH = 3;
const MIN_DUPLICATE_OVERLAP_COUNT = 2;
const MIN_DUPLICATE_OVERLAP_RATIO = 0.75;

const normalizeMatterName = (value: string) =>
  value.trim().replace(/\s+/gu, " ").toLowerCase();

const tokenizeMatterName = (value: string) =>
  normalizeMatterName(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= MIN_DUPLICATE_TOKEN_LENGTH);

const createEmptyCollaboratorStats = (): CollaboratorStats => ({
  activityCount: 0,
  lastActivityMs: 0,
  sharedCount: 0,
  sharedLastActivityMs: 0,
});

export const isPossibleDuplicateMatter = ({
  clientId,
  name,
  workspace,
}: {
  clientId: string;
  name: string;
  workspace: ExistingWorkspace;
}) => {
  if (workspace.client?.id !== clientId) {
    return false;
  }

  const normalizedName = normalizeMatterName(name);
  const normalizedExistingName = normalizeMatterName(workspace.name);

  if (!normalizedName || !normalizedExistingName) {
    return false;
  }

  if (normalizedName === normalizedExistingName) {
    return true;
  }

  const nameTokens = tokenizeMatterName(normalizedName);
  const existingNameTokens = tokenizeMatterName(normalizedExistingName);

  if (
    nameTokens.length < MIN_DUPLICATE_OVERLAP_COUNT ||
    existingNameTokens.length < MIN_DUPLICATE_OVERLAP_COUNT
  ) {
    return false;
  }

  const shorterTokenList =
    nameTokens.length <= existingNameTokens.length
      ? nameTokens
      : existingNameTokens;
  const longerTokenSet = new Set(
    nameTokens.length <= existingNameTokens.length
      ? existingNameTokens
      : nameTokens,
  );

  let overlapCount = 0;

  for (const token of shorterTokenList) {
    if (longerTokenSet.has(token)) {
      overlapCount += 1;
    }
  }

  return (
    overlapCount >= MIN_DUPLICATE_OVERLAP_COUNT &&
    overlapCount / shorterTokenList.length >= MIN_DUPLICATE_OVERLAP_RATIO
  );
};

export const getPossibleDuplicateMatters = ({
  clientId,
  name,
  workspaces,
  limit,
}: {
  clientId: string;
  limit: number;
  name: string;
  workspaces: ExistingWorkspace[];
}) => {
  const result: ExistingWorkspace[] = [];

  for (const workspace of workspaces) {
    if (
      !isPossibleDuplicateMatter({
        clientId,
        name,
        workspace,
      })
    ) {
      continue;
    }

    result.push(workspace);

    if (result.length === limit) {
      break;
    }
  }

  return result;
};

export const buildCollaboratorStats = ({
  currentUserId,
  workspaces,
}: {
  currentUserId: string;
  workspaces: ExistingWorkspace[];
}) => {
  const collaboratorStats = new Map<string, CollaboratorStats>();

  for (const workspace of workspaces) {
    const contributorIds = new Set<string>();

    for (const contributor of workspace.contributors) {
      if (contributor.userId) {
        contributorIds.add(contributor.userId);
      }
    }

    const currentUserContributed = contributorIds.has(currentUserId);

    for (const contributor of workspace.contributors) {
      if (!contributor.userId || contributor.userId === currentUserId) {
        continue;
      }

      const contributorLastActivityMs =
        contributor.lastActivity !== null &&
        contributor.lastActivity !== undefined
          ? new Date(contributor.lastActivity).getTime()
          : 0;
      const existing =
        collaboratorStats.get(contributor.userId) ??
        createEmptyCollaboratorStats();

      existing.activityCount += 1;
      existing.lastActivityMs = Math.max(
        existing.lastActivityMs,
        contributorLastActivityMs,
      );

      if (currentUserContributed) {
        existing.sharedCount += 1;
        existing.sharedLastActivityMs = Math.max(
          existing.sharedLastActivityMs,
          contributorLastActivityMs,
        );
      }

      collaboratorStats.set(contributor.userId, existing);
    }
  }

  return collaboratorStats;
};

export const compareMembersByCollaboratorStats = ({
  a,
  b,
  collaboratorStats,
}: {
  a: OrganizationMember;
  b: OrganizationMember;
  collaboratorStats: Map<string, CollaboratorStats>;
}) => {
  const aStats =
    collaboratorStats.get(a.userId) ?? createEmptyCollaboratorStats();
  const bStats =
    collaboratorStats.get(b.userId) ?? createEmptyCollaboratorStats();

  if (aStats.sharedCount !== bStats.sharedCount) {
    return bStats.sharedCount - aStats.sharedCount;
  }

  if (aStats.sharedLastActivityMs !== bStats.sharedLastActivityMs) {
    return bStats.sharedLastActivityMs - aStats.sharedLastActivityMs;
  }

  if (aStats.activityCount !== bStats.activityCount) {
    return bStats.activityCount - aStats.activityCount;
  }

  if (aStats.lastActivityMs !== bStats.lastActivityMs) {
    return bStats.lastActivityMs - aStats.lastActivityMs;
  }

  return a.user.name.localeCompare(b.user.name);
};
