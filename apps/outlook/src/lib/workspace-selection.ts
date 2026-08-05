import type { MailSnapshot, WorkspaceSummary } from "@/types";

const MIN_PHRASE_LENGTH = 3;
const REFERENCE_SCORE = 100;
const CLIENT_SCORE = 40;
const MATTER_SCORE = 30;

const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");

const containsPhrase = (haystack: string, value: string | null): boolean => {
  if (!value) {
    return false;
  }
  const phrase = normalizeSearchText(value);
  if (phrase.length < MIN_PHRASE_LENGTH) {
    return false;
  }
  return ` ${haystack} `.includes(` ${phrase} `);
};

export const filterWorkspaces = ({
  query,
  workspaces,
}: {
  query: string;
  workspaces: WorkspaceSummary[];
}): WorkspaceSummary[] => {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) {
    return workspaces;
  }

  return workspaces.filter((workspace) =>
    normalizeSearchText(
      [workspace.name, workspace.reference, workspace.clientName]
        .filter((value): value is string => !!value)
        .join(" "),
    ).includes(normalizedQuery),
  );
};

export const suggestWorkspaceId = ({
  snapshot,
  workspaces,
}: {
  snapshot: MailSnapshot;
  workspaces: WorkspaceSummary[];
}): string | null => {
  const haystack = normalizeSearchText(
    [
      snapshot.subject,
      snapshot.bodyText,
      snapshot.from?.email,
      ...snapshot.attachments.map((attachment) => attachment.name),
    ]
      .filter((value): value is string => !!value)
      .join(" "),
  );

  let best: { score: number; workspaceId: string } | null = null;
  let bestScoreIsTied = false;
  for (const workspace of workspaces) {
    let score = 0;
    if (containsPhrase(haystack, workspace.reference)) {
      score += REFERENCE_SCORE;
    }
    if (containsPhrase(haystack, workspace.clientName)) {
      score += CLIENT_SCORE;
    }
    if (containsPhrase(haystack, workspace.name)) {
      score += MATTER_SCORE;
    }

    if (score === 0) {
      continue;
    }
    if (!best || score > best.score) {
      best = { score, workspaceId: workspace.id };
      bestScoreIsTied = false;
      continue;
    }
    if (score === best.score) {
      bestScoreIsTied = true;
    }
  }

  return best && !bestScoreIsTied ? best.workspaceId : null;
};
