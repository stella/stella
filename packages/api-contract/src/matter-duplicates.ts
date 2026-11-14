/**
 * Whether a matter about to be created looks like one the client already has,
 * so the web's and the phone's create flows warn about the same matters.
 */

/** What the check reads of an existing matter. */
export type DuplicateMatterCandidate = {
  readonly client?: { readonly id: string } | null | undefined;
  readonly name: string;
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
  workspace: DuplicateMatterCandidate;
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

/** The client's first `limit` matters whose names resemble `name`. */
export const getPossibleDuplicateMatters = <
  TWorkspace extends DuplicateMatterCandidate,
>({
  clientId,
  name,
  workspaces,
  limit,
}: {
  clientId: string;
  limit: number;
  name: string;
  workspaces: readonly TWorkspace[];
}): TWorkspace[] => {
  const result: TWorkspace[] = [];

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
