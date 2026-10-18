type ExistingWorkspace = {
  client?: { id: string } | null;
  members: {
    lastActivity?: string | null;
    userId?: string | null;
  }[];
  id: string;
  name: string;
  reference?: string | null;
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
