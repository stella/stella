import { panic } from "better-result";

import { escapeRegExp, foldSearchMatchText } from "@stll/text-normalize";

import type { McpConnectionsResponse } from "@/lib/knowledge/queries";

export type McpReconnectCandidate = Pick<
  McpConnectionsResponse["connections"][number],
  "id" | "status" | "expiresAt"
> & {
  displayName: string;
  slug: string;
};

const MIN_MATCH_LENGTH = 3;

/** No connection name can match text shorter than the shortest matchable name. */
export const canMentionMcpConnection = (text: string) =>
  Array.from(text.trim()).length >= MIN_MATCH_LENGTH;

const containsWholeName = (text: string, name: string) => {
  if (Array.from(name).length < MIN_MATCH_LENGTH) {
    return false;
  }
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}\\p{M}_])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}\\p{M}_])`,
    "u",
  ).test(text);
};

export const matchBrokenMcpConnections = <
  Candidate extends McpReconnectCandidate,
>(
  text: string,
  candidates: readonly Candidate[],
) => {
  if (!canMentionMcpConnection(text)) {
    return [];
  }
  const foldedText = foldSearchMatchText(text);
  return candidates.filter((candidate) => {
    switch (candidate.status) {
      case "connected":
        return false;
      case "needs_reauth":
      case "revoked":
      case "needs_approval":
        break;
      default:
        return panic(candidate.status satisfies never);
    }
    return [
      candidate.displayName,
      candidate.slug,
      candidate.slug.replace(/[-_]/gu, " "),
    ].some((name) =>
      containsWholeName(foldedText, foldSearchMatchText(name).trim()),
    );
  });
};

export const mcpReconnectDismissKey = ({
  id,
  status,
  expiresAt,
}: Pick<McpReconnectCandidate, "id" | "status" | "expiresAt">) =>
  `${id}:${status}:${expiresAt ?? ""}`;
